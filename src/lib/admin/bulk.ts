// src/lib/admin/bulk.ts
//
// Bulk actions with a preview — the one pattern for any admin action that
// touches many records at once. Two requests:
//
//   POST …/preview { selection }
//     The server resolves the selection to the exact records it would touch
//     and answers { count, sample, totals, token, expiresAt, confirmPhrase }.
//     Nothing changes.
//
//   POST …/apply { selection, token, confirm? }
//     Resolves the selection again and refuses unless
//       - the token is genuine (HMAC), unexpired (10 minutes) and unused,
//       - it was issued to this administrator for this action,
//       - the records resolve to exactly the set the preview showed
//         (a record that appeared, disappeared or changed since is a
//         "selection_changed" refusal — preview again), and
//       - for destructive actions, `confirm` is the phrase the preview gave.
//     Only then is the action run, once (the token is spent first).
//
// How to adopt it in another admin section:
//
//   const action = defineBulkAction({
//     name: "groups.archive",            // unique; part of the token
//     destructive: true,                  // needs the typed phrase
//     parse: (input) => ...,              // body.selection -> S, or null
//     resolve: async (selection) => [...],// -> BulkRecord[] (id + fingerprint)
//     totals: (records) => ({ bytes }),   // counts for the preview
//     run: async (records, selection, actor) => ({...}),
//   });
//   // preview route: return NextResponse.json(await bulkPreview(action, ctx, selection));
//   // apply route:   const r = await bulkApply(action, { ...actorOf(ctx), req }, body);
//   //                 if ("refusal" in r) return r.refusal;
// src/app/api/admin/data/bulk/[action]/[step]/route.ts is a worked example.
//
// The routes still do requireAdmin() and the audit entry themselves; this
// module only guarantees "what you saw is what runs".

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { kv } from "@/lib/kv";
import { fail } from "@/lib/admin/http";
import type { NextResponse } from "next/server";

export const PREVIEW_TTL_MS = 10 * 60 * 1000;
export const SAMPLE_SIZE = 20;
const usedKey = (jti: string) => `neo:admin:bulk:used:${jti}`;

/** One record a bulk action would touch. `fingerprint` changes when the record does. */
export interface BulkRecord {
  id: string;
  /** Anything that, if different at apply time, means the admin saw something else. */
  fingerprint?: string;
  /** What the preview shows for it (already redacted for the viewer). */
  view?: Record<string, unknown>;
}

/** Who is applying it, for the action's own audit entries. */
export interface BulkActor {
  userId: string;
  email: string;
  req: Request | null;
}

export interface BulkAction<S, R extends BulkRecord = BulkRecord, O = unknown> {
  name: string;
  destructive: boolean;
  /** Normalise the request body's selection; null = invalid. */
  parse: (input: unknown) => S | null;
  resolve: (selection: S) => Promise<R[]>;
  /** Totals for the preview, e.g. { bytes, objects }. */
  totals?: (records: R[]) => Record<string, number>;
  /** Anything else the preview should say (e.g. records left out and why). Not part of the token. */
  extra?: (selection: S, records: R[]) => Promise<Record<string, unknown>>;
  /** Why it cannot run right now (e.g. the same job is already running), checked before the token is spent. */
  busy?: (selection: S) => Promise<string | null>;
  run: (records: R[], selection: S, actor: BulkActor) => Promise<O>;
}

export function defineBulkAction<S, R extends BulkRecord = BulkRecord, O = unknown>(a: BulkAction<S, R, O>): BulkAction<S, R, O> {
  return a;
}

function key(): Buffer {
  const s = process.env.ADMIN_MFA_KEY || process.env.CLERK_SECRET_KEY;
  if (!s) throw new Error("ADMIN_MFA_KEY or CLERK_SECRET_KEY must be set for admin bulk actions");
  return Buffer.from(hkdfSync("sha256", s, "neo-admin", "bulk-preview", 32));
}

/** A stable digest of the exact records (order does not matter). */
export function digestRecords(records: BulkRecord[]): string {
  const lines = records.map((r) => `${r.id}\u0000${r.fingerprint ?? ""}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("base64url");
}

interface TokenBody {
  a: string; // action
  u: string; // administrator
  d: string; // record digest
  n: number; // count
  e: number; // expires
  j: string; // one-use id
}

function sign(body: TokenBody): string {
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const mac = createHmac("sha256", key()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function verify(token: string): TokenBody | null {
  const [payload, mac] = String(token || "").split(".");
  if (!payload || !mac) return null;
  const want = createHmac("sha256", key()).update(payload).digest();
  let got: Buffer;
  try {
    got = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenBody;
  } catch {
    return null;
  }
}

/** The words a destructive bulk action must be confirmed with. */
export function confirmPhraseFor(name: string, count: number): string {
  const verb = name.split(".").pop() || name;
  return `${verb} ${count}`;
}

export interface BulkPreview {
  action: string;
  count: number;
  sample: Record<string, unknown>[];
  totals: Record<string, number>;
  token: string;
  expiresAt: number;
  destructive: boolean;
  confirmPhrase: string | null;
  extra: Record<string, unknown>;
}

export async function bulkPreview<S, R extends BulkRecord, O>(
  action: BulkAction<S, R, O>,
  actor: { userId: string },
  selection: S,
): Promise<BulkPreview> {
  const records = await action.resolve(selection);
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const token = sign({
    a: action.name,
    u: actor.userId,
    d: digestRecords(records),
    n: records.length,
    e: expiresAt,
    j: randomBytes(9).toString("base64url"),
  });
  return {
    action: action.name,
    count: records.length,
    sample: records.slice(0, SAMPLE_SIZE).map((r) => ({ id: r.id, ...(r.view ?? {}) })),
    totals: { records: records.length, ...(action.totals?.(records) ?? {}) },
    token,
    expiresAt,
    destructive: action.destructive,
    confirmPhrase: action.destructive ? confirmPhraseFor(action.name, records.length) : null,
    extra: action.extra ? await action.extra(selection, records) : {},
  };
}

export type BulkApplyResult<R, O> = { refusal: NextResponse } | { records: R[]; output: O; count: number };

/** Check the token against a fresh resolve, spend it, run. */
export async function bulkApply<S, R extends BulkRecord, O>(
  action: BulkAction<S, R, O>,
  actor: BulkActor,
  body: { selection?: unknown; token?: unknown; confirm?: unknown } | null,
): Promise<BulkApplyResult<R, O>> {
  const selection = action.parse(body?.selection);
  if (selection == null) return { refusal: fail("bad_selection", "That selection is not valid.", 400) };
  if (typeof body?.token !== "string" || !body.token) {
    return { refusal: fail("preview_required", "Preview this action first; applying needs the preview's token.", 400) };
  }
  const t = verify(body.token);
  if (!t || t.a !== action.name || t.u !== actor.userId) {
    return { refusal: fail("bad_token", "That preview token is not valid for this action.", 400) };
  }
  if (t.e < Date.now()) return { refusal: fail("preview_expired", "The preview has expired (10 minutes). Preview again.", 409) };
  const records = await action.resolve(selection);
  if (records.length !== t.n || digestRecords(records) !== t.d) {
    return {
      refusal: fail("selection_changed", "The records changed since the preview. Preview again to see what would be affected now.", 409, {
        previewCount: t.n,
        nowCount: records.length,
      }),
    };
  }
  if (action.destructive) {
    const phrase = confirmPhraseFor(action.name, records.length);
    if (typeof body?.confirm !== "string" || body.confirm.trim().toLowerCase() !== phrase.toLowerCase()) {
      return { refusal: fail("confirmation_required", `Type "${phrase}" to confirm.`, 400, { confirmPhrase: phrase }) };
    }
  }
  const busy = action.busy ? await action.busy(selection) : null;
  if (busy) return { refusal: fail("busy", busy, 409) };
  // Spend the token before running, so a double submit cannot run twice.
  const spent = await kv.set(usedKey(t.j), "1", { nx: true, px: PREVIEW_TTL_MS + 60_000 });
  if (!spent) return { refusal: fail("token_used", "That preview was already applied. Preview again.", 409) };
  const output = await action.run(records, selection, actor);
  return { records, output, count: records.length };
}

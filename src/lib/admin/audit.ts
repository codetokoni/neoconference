// src/lib/admin/audit.ts
//
// What administrators did: who, when, from where, to what, and the values
// before and after. Separate from src/lib/auditLog.ts, which records every
// meeting/group permission decision and is capped at 5000.
//
// Append-only and never trimmed:
//
//   neo:admin:audit:<YYYY-MM>   list, newest first (LPUSH)
//   neo:admin:audit:months      set of months that have entries
//   neo:admin:audit:seq         counter; every entry takes the next number
//
// Nothing in the app edits or deletes an entry — there is no route for it.
// Someone with direct database access still could, so every entry carries a
// sequence number: a removed entry leaves a gap that checkAuditIntegrity()
// reports on the Audit log page.
//
// The one exception is the audit retention period (src/lib/dataGov), off by
// default and never shorter than a year: purgeAuditMonths() removes whole
// months older than it, and records the highest sequence number removed
// (neo:admin:audit:purgedThrough) so those gaps are not reported as tampering.

import { kv } from "@/lib/kv";
import { activity } from "@/lib/activity";

const MONTHS = "neo:admin:audit:months";
const SEQ = "neo:admin:audit:seq";
const PURGED_THROUGH = "neo:admin:audit:purgedThrough";
const monthKey = (m: string) => `neo:admin:audit:${m}`;

export interface AdminAuditEntry {
  seq: number;
  ts: number;
  actorId: string;
  actorEmail: string;
  /** e.g. "admin.appoint", "role.update", "user.suspend", "mfa.verify.failed" */
  action: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  before?: unknown;
  after?: unknown;
  note?: string;
  ip?: string;
  userAgent?: string;
  outcome: "ok" | "denied" | "failed";
}

export interface AuditActor {
  userId: string;
  email: string;
}

export type AuditInput = Omit<AdminAuditEntry, "seq" | "ts" | "actorId" | "actorEmail" | "ip" | "userAgent" | "outcome"> & {
  outcome?: AdminAuditEntry["outcome"];
};

function monthOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

export function requestOrigin(req: Request | null | undefined): { ip?: string; userAgent?: string } {
  if (!req) return {};
  const fwd = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "";
  const ip = fwd.split(",")[0]?.trim() || undefined;
  const userAgent = req.headers.get("user-agent")?.slice(0, 300) || undefined;
  return { ip, userAgent };
}

/**
 * Record one administrative action. Awaited by callers — on Vercel work left
 * running after the response is sent can be dropped, and an audit entry is
 * not optional. A KV failure is logged and swallowed so the audit sink
 * cannot undo a change that already happened.
 */
export async function recordAdminAction(
  actor: AuditActor,
  req: Request | null,
  input: AuditInput,
): Promise<AdminAuditEntry | null> {
  try {
    const ts = Date.now();
    const seq = Number(await kv.incr(SEQ));
    const entry: AdminAuditEntry = {
      outcome: "ok",
      ...input,
      seq,
      ts,
      actorId: actor.userId,
      actorEmail: actor.email,
      ...requestOrigin(req),
    };
    const m = monthOf(ts);
    await kv.lpush(monthKey(m), JSON.stringify(entry));
    await kv.sadd(MONTHS, m);
    // A wrong or locked-out authenticator code is a failed admin sign-in:
    // counted in the activity log too, for the security figures.
    if (entry.action.startsWith("mfa.") && entry.outcome !== "ok") {
      await activity.record("admin.sign_in_failed", {
        userId: entry.actorId,
        severity: entry.action === "mfa.locked" ? "error" : "warn",
        props: { action: entry.action, ip: entry.ip ?? null },
      });
    }
    return entry;
  } catch (err) {
    console.error("[admin-audit] write failed", input.action, err);
    return null;
  }
}

function parse(raw: unknown): AdminAuditEntry | null {
  if (raw && typeof raw === "object") return raw as AdminAuditEntry;
  try {
    return JSON.parse(String(raw)) as AdminAuditEntry;
  } catch {
    return null;
  }
}

async function monthsNewestFirst(): Promise<string[]> {
  const ms = ((await kv.smembers(MONTHS)) ?? []) as string[];
  return [...ms].sort().reverse();
}

export interface AuditQuery {
  /** Matches actor email or id (substring). */
  actor?: string;
  /** Action prefix, e.g. "admin." or "user.suspend". */
  action?: string;
  /** Matches target id or label (substring). */
  target?: string;
  /** Free text across the whole entry. */
  q?: string;
  outcome?: AdminAuditEntry["outcome"];
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export async function listAdminAudit(query: AuditQuery = {}): Promise<{ items: AdminAuditEntry[]; total: number }> {
  const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
  const offset = Math.max(0, query.offset ?? 0);
  const actor = query.actor?.toLowerCase();
  const target = query.target?.toLowerCase();
  const q = query.q?.toLowerCase();
  const matches: AdminAuditEntry[] = [];
  for (const m of await monthsNewestFirst()) {
    // Skip whole months outside the range.
    if (query.from && m < monthOf(query.from)) break;
    if (query.to && m > monthOf(query.to)) continue;
    const raw = ((await kv.lrange(monthKey(m), 0, -1)) ?? []) as unknown[];
    for (const r of raw) {
      const e = parse(r);
      if (!e) continue;
      if (query.from && e.ts < query.from) continue;
      if (query.to && e.ts > query.to) continue;
      if (actor && !`${e.actorEmail} ${e.actorId}`.toLowerCase().includes(actor)) continue;
      if (query.action && !e.action.startsWith(query.action)) continue;
      if (target && !`${e.targetId ?? ""} ${e.targetLabel ?? ""}`.toLowerCase().includes(target)) continue;
      if (query.outcome && e.outcome !== query.outcome) continue;
      if (q && !JSON.stringify(e).toLowerCase().includes(q)) continue;
      matches.push(e);
    }
  }
  matches.sort((a, b) => b.seq - a.seq);
  return { items: matches.slice(offset, offset + limit), total: matches.length };
}

/** Every number handed out should still be in the log; any that is not was removed outside the app. */
export async function checkAuditIntegrity(): Promise<{ expected: number; present: number; missing: number[]; purgedThrough: number }> {
  const expected = Number((await kv.get(SEQ)) ?? 0);
  const purgedThrough = Number((await kv.get(PURGED_THROUGH)) ?? 0);
  const seen = new Set<number>();
  for (const m of await monthsNewestFirst()) {
    const raw = ((await kv.lrange(monthKey(m), 0, -1)) ?? []) as unknown[];
    for (const r of raw) {
      const e = parse(r);
      if (e) seen.add(e.seq);
    }
  }
  const missing: number[] = [];
  for (let i = purgedThrough + 1; i <= expected && missing.length < 50; i++) if (!seen.has(i)) missing.push(i);
  return { expected, present: seen.size, missing, purgedThrough };
}

/**
 * Remove whole months under the audit retention period. Only the data
 * governance purge calls this, after a preview the administrator confirmed;
 * the purge itself is then audited (in the current month, which is never
 * removed).
 */
export async function purgeAuditMonths(months: string[]): Promise<{ months: number; entries: number; purgedThrough: number }> {
  const current = monthOf(Date.now());
  let entries = 0;
  let removedMonths = 0;
  let highest = Number((await kv.get(PURGED_THROUGH)) ?? 0);
  for (const m of months) {
    if (!/^\d{4}-\d{2}$/.test(m) || m >= current) continue;
    const raw = ((await kv.lrange(monthKey(m), 0, -1)) ?? []) as unknown[];
    for (const r of raw) {
      const e = parse(r);
      if (e && e.seq > highest) highest = e.seq;
    }
    entries += raw.length;
    removedMonths++;
    await kv.del(monthKey(m));
    await kv.srem(MONTHS, m);
  }
  await kv.set(PURGED_THROUGH, highest);
  return { months: removedMonths, entries, purgedThrough: highest };
}

/** What changed between two flat records, for compact before/after display. */
export function diff(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const x = before?.[k];
    const y = after?.[k];
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      b[k] = x;
      a[k] = y;
    }
  }
  return { before: b, after: a };
}

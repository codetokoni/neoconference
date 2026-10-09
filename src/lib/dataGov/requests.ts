// src/lib/dataGov/requests.ts
//
// Deletion requests and legal holds. Built on phase 2's pending deletion
// (src/lib/admin/users.ts, neo:admin:deletions): a request — from the person
// on their account page or from an administrator — is that same record, so
// there is one soft-delete and one grace period (the "accounts" retention
// setting). This file adds what the queue needs around it:
//
//   neo:admin:deletions    hash  uid -> PendingDeletion   (phase 2; open requests)
//   neo:data:requests:log  list  JSON ClosedRequest, newest first, capped
//                                 (cancelled, refused, completed — no personal data)
//   neo:data:holds         hash  uid -> LegalHold
//   neo:data:erased        set   uids whose deletion was completed (a tombstone:
//                                 the id alone, so a restore can tell)
//
// Status of an open request: "requested" while its grace period runs,
// "scheduled" once it is due (waiting for an administrator to complete it).
// Closed: "completed", "cancelled", or "refused" (a legal hold blocked it).

import { kv } from "@/lib/kv";
import { DAY_MS, retentionDays } from "@/lib/dataGov/settings";
import { allDeletions, clearDeletion, getDeletion, setDeletion, type PendingDeletion } from "@/lib/admin/users";

const LOG = "neo:data:requests:log";
const LOG_MAX = 1000;
const HOLDS = "neo:data:holds";
const ERASED = "neo:data:erased";

export type RequestStatus = "requested" | "scheduled" | "completed" | "cancelled" | "refused";

/** Phase 2's record, with who asked. Older records have no `source` (an administrator asked). */
export type DeletionRequest = PendingDeletion & { source?: "user" | "admin"; id?: string };

export interface ClosedRequest {
  id: string;
  userId: string;
  status: "completed" | "cancelled" | "refused";
  source: "user" | "admin";
  requestedAt: number;
  deleteAfter: number;
  closedAt: number;
  /** "user" when the person cancelled; otherwise the administrator's id. */
  closedBy: string;
  certificateId?: string;
  note?: string;
}

export interface LegalHold {
  at: number;
  byId: string;
  byEmail: string;
  reason: string;
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

export function requestId(uid: string, requestedAt: number): string {
  return `del_${requestedAt.toString(36)}_${uid.slice(-6)}`;
}

export function openStatus(d: PendingDeletion, now = Date.now()): "requested" | "scheduled" {
  return d.deleteAfter <= now ? "scheduled" : "requested";
}

export async function graceMs(): Promise<number> {
  return ((await retentionDays("accounts")) ?? 30) * DAY_MS;
}

/* --------------------------------- holds ---------------------------------- */

export async function getHold(uid: string): Promise<LegalHold | null> {
  return parse<LegalHold>(await kv.hget(HOLDS, uid));
}

export async function allHolds(): Promise<Map<string, LegalHold>> {
  const all = ((await kv.hgetall(HOLDS)) ?? {}) as Record<string, unknown>;
  const out = new Map<string, LegalHold>();
  for (const [uid, v] of Object.entries(all)) {
    const h = parse<LegalHold>(v);
    if (h) out.set(uid, h);
  }
  return out;
}

export async function setHold(uid: string, hold: LegalHold | null): Promise<void> {
  if (hold) await kv.hset(HOLDS, { [uid]: JSON.stringify(hold) });
  else await kv.hdel(HOLDS, uid);
}

/* ------------------------------- open requests ----------------------------- */

export async function getRequest(uid: string): Promise<DeletionRequest | null> {
  return (await getDeletion(uid)) as DeletionRequest | null;
}

export async function openRequests(): Promise<Map<string, DeletionRequest>> {
  return (await allDeletions()) as Map<string, DeletionRequest>;
}

export async function createRequest(
  uid: string,
  input: { source: "user" | "admin"; byId: string; byEmail: string; reason: string; wasBanned: boolean },
  now = Date.now(),
): Promise<DeletionRequest> {
  const d: DeletionRequest = {
    id: requestId(uid, now),
    source: input.source,
    requestedAt: now,
    deleteAfter: now + (await graceMs()),
    requestedById: input.byId,
    requestedByEmail: input.byEmail,
    reason: input.reason,
    wasBanned: input.wasBanned,
  };
  await setDeletion(uid, d);
  return d;
}

/** Move every open request's date to requestedAt + the new grace period. */
export async function rescheduleOpen(newGraceMs: number): Promise<number> {
  let n = 0;
  for (const [uid, d] of await openRequests()) {
    const deleteAfter = d.requestedAt + newGraceMs;
    if (deleteAfter === d.deleteAfter) continue;
    await setDeletion(uid, { ...d, deleteAfter });
    n++;
  }
  return n;
}

/** Close an open request (cancelled / refused / completed) and keep the non-personal record. */
export async function closeRequest(
  uid: string,
  d: DeletionRequest,
  status: ClosedRequest["status"],
  closedBy: string,
  extra: { certificateId?: string; note?: string } = {},
  now = Date.now(),
): Promise<ClosedRequest> {
  const closed: ClosedRequest = {
    id: d.id ?? requestId(uid, d.requestedAt),
    userId: uid,
    status,
    source: d.source ?? "admin",
    requestedAt: d.requestedAt,
    deleteAfter: d.deleteAfter,
    closedAt: now,
    closedBy,
    ...extra,
  };
  await clearDeletion(uid);
  await logClosed(closed);
  return closed;
}

export async function logClosed(c: ClosedRequest): Promise<void> {
  await kv.lpush(LOG, JSON.stringify(c));
  await kv.ltrim(LOG, 0, LOG_MAX - 1);
}

export async function closedRequests(limit = 200): Promise<ClosedRequest[]> {
  const raw = ((await kv.lrange(LOG, 0, Math.min(limit, LOG_MAX) - 1)) ?? []) as unknown[];
  return raw.map((r) => parse<ClosedRequest>(r)).filter((c): c is ClosedRequest => !!c);
}

/** The person's most recent closed request, for their account page. */
export async function lastClosedFor(uid: string): Promise<ClosedRequest | null> {
  return (await closedRequests(LOG_MAX)).find((c) => c.userId === uid) ?? null;
}

/* --------------------------------- erased ---------------------------------- */

export async function markErased(uid: string): Promise<void> {
  await kv.sadd(ERASED, uid);
}

export async function isErased(uid: string): Promise<boolean> {
  return Number(await kv.sismember(ERASED, uid)) === 1;
}

export async function erasedUserIds(): Promise<string[]> {
  return ((await kv.smembers(ERASED)) ?? []) as string[];
}

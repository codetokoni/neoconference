// src/lib/waitingRoom.ts
//
// How long a host's answer at the waiting room lasts.
//
// It used to last forever. Admitting someone flipped their queue entry to
// 'admitted' and also wrote them a pre-approved viewer role, and nothing
// ever cleared either: once let in, a person skipped that room's waiting
// room on every later visit. A refusal was just as permanent — the entry
// stayed 'denied' and every knock answered with it — which in an
// always-open room meant never getting in again.
//
// Now:
//  - An admission lasts for one session of the meeting: until the room
//    empties and LiveKit closes it (room_finished). A dropped connection
//    mid-meeting does not send anyone back to the queue.
//  - A refusal is shown for a minute, long enough to reach the person who
//    was knocking. After that a knock is a new request.

import { kv } from "@vercel/kv";
import type { NeoEvent, RoleAssignment, WaitingRoomEntry } from "@/types/event";

/**
 * How long after its last knock someone counts as still waiting.
 *
 * Both the app and the web room knock every 4 s while waiting, and nothing
 * says when they stop — someone who closed the app or walked away stayed
 * in the host's list until refused (one sat there an afternoon). Thirty
 * seconds is several missed knocks, so a slow link is not mistaken for
 * leaving.
 */
export const KNOCK_GONE_MS = 30_000;

// Kept apart from the event, in a key that expires by itself. Writing it
// into the event every 4 s would be a read-modify-write of the whole event
// racing the host's Admit, and could put a just-admitted person back to
// 'pending'.
const knockKey = (eventId: string, userId: string) =>
  `neo:knock:${eventId}:${userId}`;
const memKnocks = new Map<string, number>();
const kvConfigured = () =>
  Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

/** Records that this person knocked just now. */
export async function noteKnock(eventId: string, userId: string, now = Date.now()) {
  const key = knockKey(eventId, userId);
  if (!kvConfigured()) {
    memKnocks.set(key, now);
    return;
  }
  await kv.set(key, now, { px: KNOCK_GONE_MS });
}

/** When each of these people last knocked, where it is recent enough to know. */
export async function lastKnocks(
  eventId: string,
  userIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;
  const keys = userIds.map((id) => knockKey(eventId, id));
  const values: unknown[] = kvConfigured()
    ? await kv.mget<unknown[]>(...keys)
    : keys.map((k) => memKnocks.get(k));
  userIds.forEach((id, i) => {
    const v = Number(values[i]);
    if (Number.isFinite(v) && v > 0) out.set(id, v);
  });
  return out;
}

/**
 * The queue as a host should see it: everyone admitted or refused, and
 * only those pending who are still knocking. Entries are not removed —
 * someone who comes back knocks again and reappears — only not shown.
 */
export function stillWaiting(
  entries: WaitingRoomEntry[],
  lastKnock: Map<string, number>,
  now: number
): WaitingRoomEntry[] {
  return entries.filter((e) => {
    if (e.status !== "pending") return true;
    const at = lastKnock.get(e.id);
    return at !== undefined && now - at < KNOCK_GONE_MS;
  });
}

/** How long a refusal answers further knocks before a knock is new again. */
export const REFUSAL_HOLDS_MS = 60_000;

/** A refusal recent enough to still be the answer. */
export function refusalHolds(entry: WaitingRoomEntry, now: number): boolean {
  if (entry.status !== "denied") return false;
  // Refusals from before decidedAt existed have no time; they are the
  // stuck ones this is here to release.
  return typeof entry.decidedAt === "number" && now - entry.decidedAt < REFUSAL_HOLDS_MS;
}

/**
 * What the token route tells someone the waiting room says about them.
 * A refusal that no longer holds reads as never having knocked, so the
 * client knocks again rather than showing an old "no".
 */
export function gateStatus(
  entry: WaitingRoomEntry | undefined,
  now: number
): "admitted" | "pending" | "denied" | "not_knocked" {
  if (!entry) return "not_knocked";
  if (entry.status === "denied") return refusalHolds(entry, now) ? "denied" : "not_knocked";
  return entry.status;
}

/**
 * A role the old admit wrote: a pre-approved viewer whose identifier is an
 * admitted queue entry. Invites and ticket purchases write pre-approved
 * roles too, and those must stay — they are why this matches on the queue
 * entry and not on the role alone.
 */
function admitWroteRole(role: RoleAssignment, admitted: Set<string>): boolean {
  return (
    role.role === "viewer" &&
    role.preApproved === true &&
    admitted.has(role.identifier.toLowerCase())
  );
}

/**
 * The event as it should be once its room has emptied: admissions and
 * refusals from the session that just ended are dropped, with the roles
 * the old admit wrote for them. Someone still knocking stays in the queue.
 *
 * Returns null when there is nothing to clear, so the caller can skip the
 * write.
 */
export function clearedForNewSession(
  ev: Pick<NeoEvent, "waitingRoom" | "roles">
): { waitingRoom: WaitingRoomEntry[]; roles: RoleAssignment[] } | null {
  const queue = ev.waitingRoom || [];
  const roles = ev.roles || [];
  const admitted = new Set(
    queue.filter((e) => e.status === "admitted").map((e) => e.id.toLowerCase())
  );
  const waitingRoom = queue.filter((e) => e.status === "pending");
  const keptRoles = roles.filter((r) => !admitWroteRole(r, admitted));
  if (waitingRoom.length === queue.length && keptRoles.length === roles.length) {
    return null;
  }
  return { waitingRoom, roles: keptRoles };
}

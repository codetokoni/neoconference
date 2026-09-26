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

import type { NeoEvent, RoleAssignment, WaitingRoomEntry } from "@/types/event";

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

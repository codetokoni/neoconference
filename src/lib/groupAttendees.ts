// src/lib/groupAttendees.ts
//
// A meeting's attendees as candidates for a group. Read from the attendance
// journal (src/lib/attendance.ts), never written to it.
//
// Pure module: no Clerk, no Next, no HTTP.

import { fetchAttendanceReport } from "@/lib/attendance";
import type { NeoEvent } from "@/types/event";
import type { NewMember } from "@/lib/groupStore";

/** States in which a meeting has (or had) people in it. */
const ATTENDED_STATES = new Set(["live", "ended", "replay"]);

export function hasAttendance(event: Pick<NeoEvent, "state">): boolean {
  return ATTENDED_STATES.has(event.state);
}

export interface Attendee {
  userId: string;
  name: string;
  email: string;
}

/** A Clerk account id, as the token route stamps it on a LiveKit identity. */
const CLERK_USER_ID = /^user_[A-Za-z0-9]+$/;

/** Server-side participants the webhook also journals: captions, AI agents. */
const SERVICE_IDENTITY = /^(agent-|neo-captions|EG_)/i;

/**
 * Who was in a meeting. One row per signed-in person (the report already
 * merges by userId); anyone without an account comes back separately, by name
 * only. Captions and agent participants are not people and are left out.
 */
export async function eventAttendees(event: NeoEvent): Promise<{ attendees: Attendee[]; guests: string[] }> {
  const rows = await fetchAttendanceReport(event);
  const attendees: Attendee[] = [];
  const seen = new Set<string>();
  const guests = new Set<string>();
  for (const r of rows) {
    if (r.username && SERVICE_IDENTITY.test(r.username)) continue;
    if (r.username && CLERK_USER_ID.test(r.username)) {
      if (seen.has(r.username)) continue;
      seen.add(r.username);
      attendees.push({ userId: r.username, name: r.fullName || "Member", email: r.email || "" });
    } else if (r.fullName) {
      guests.add(r.fullName);
    }
  }
  return { attendees, guests: Array.from(guests) };
}

/**
 * The chosen ids as members, or the ids that were not in the meeting. A group
 * made "from attendees" may only contain attendees: anything else would let a
 * host add arbitrary accounts by id.
 */
export function selectAttendees(
  attendees: Attendee[],
  wantedIds: string[]
): { ok: true; members: NewMember[] } | { ok: false; notAttendees: string[] } {
  const byId = new Map(attendees.map((a) => [a.userId, a]));
  const notAttendees = wantedIds.filter((id) => !byId.has(id));
  if (notAttendees.length > 0) return { ok: false, notAttendees };
  return {
    ok: true,
    members: wantedIds.map((id) => {
      const a = byId.get(id)!;
      return { userId: a.userId, name: a.name, ...(a.email ? { email: a.email } : {}) };
    }),
  };
}

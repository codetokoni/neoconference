// src/lib/partners/attendanceHooks.ts — what the LiveKit webhook tells
// partner attendance (src/lib/partners/attendance.ts). Never throws: the
// webhook's own work (the meeting's attendance list, its state) must not
// fail because of this.

import type { NeoEvent } from "@/types/event";
import { connectionClosed, connectionOpened, identityInfo, roomActivity, roomClosed, type ZoneRoom } from "@/lib/partners/attendance";

function zoneRoom(ev: NeoEvent, room: string): ZoneRoom | null {
  if (!ev.partner) return null;
  return { integrationId: ev.partner.integrationId, zoneId: ev.partner.zoneId, eventId: ev.id, room };
}

/** A participant joined or left a zone's room. Partner visitors are identified as pz-…; anyone else only keeps the session's clock. */
export async function partnerParticipantEvent(
  ev: NeoEvent,
  room: string,
  p: { identity: string; sid: string; ts: number; left: boolean },
): Promise<void> {
  try {
    const z = zoneRoom(ev, room);
    if (!z) return;
    const who = p.identity.startsWith("pz-") ? await identityInfo(p.identity) : null;
    if (!who || who.integrationId !== z.integrationId || !p.sid) {
      await roomActivity(z, p.ts, p.left);
      return;
    }
    if (p.left) await connectionClosed(p.identity, p.sid, p.ts);
    else await connectionOpened(z, p.identity, p.sid, p.ts, who);
  } catch (e) {
    console.error("[partners] attendance from webhook failed", e);
  }
}

export async function partnerRoomClosed(ev: NeoEvent, room: string): Promise<void> {
  try {
    const z = zoneRoom(ev, room);
    if (z) await roomClosed(z);
  } catch (e) {
    console.error("[partners] closing the prayer session failed", e);
  }
}

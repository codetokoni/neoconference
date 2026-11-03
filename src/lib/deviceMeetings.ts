// src/lib/deviceMeetings.ts
//
// A device signed out from another device (src/lib/deviceSessions.ts) is
// also taken out of the meetings it is in. Its sign-in no longer works, but
// a LiveKit connection made before the sign-out would otherwise stay up
// until it left by itself (owner, 2026-11-03).
//
// Node only (LiveKit's server SDK): middleware reaches this through
// POST /api/auth/device-meetings, routes call it directly.

import { livekitClient } from "@/lib/meetingSweep";
import { forgetMeetings, meetingsJoinedBy, signedOut } from "@/lib/deviceSessions";

/**
 * Takes each signed-out session's devices out of the meetings they joined.
 * Sessions that were not signed out are left alone, so this is safe for
 * anyone to ask. Someone on the same identity who joined after the
 * sign-out is a newer device, not this one, and stays. Never throws.
 */
export async function removeFromMeetings(sessionIds: string[]): Promise<number> {
  const svc = livekitClient();
  if (!svc) return 0;
  let removed = 0;
  for (const sessionId of sessionIds.slice(0, 100)) {
    try {
      const out = await signedOut(sessionId);
      if (!out) continue;
      for (const { room, identity } of await meetingsJoinedBy(sessionId)) {
        try {
          const p = await svc.getParticipant(room, identity);
          if (Number(p.joinedAt ?? 0) * 1000 > out.at) continue;
          await svc.removeParticipant(room, identity);
          removed++;
        } catch {
          // Not in that meeting any more.
        }
      }
      await forgetMeetings(sessionId);
    } catch (error) {
      console.error("[neo:deviceMeetings] could not take a signed-out device out of its meetings", error);
    }
  }
  if (removed) console.info("[neo:deviceMeetings] took", removed, "signed-out device(s) out of meetings");
  return removed;
}

// POST /api/partner/embed/attendance — the embed page's heartbeat, and the
// visitor's own prayer timer.
//
//   { session, sid? }  →  { sessionId, sessionStartedAt, seconds, connected, serverNow, beat }
//
// `sid` is the page's LiveKit connection: while it is in the meeting the
// page sends it every 20 seconds. Without it, this only reads the timer
// (after leaving, say). The timer is the visitor's counted time in the
// zone's current prayer session, worked out on the server from LiveKit's
// timestamps (src/lib/partners/attendance.ts); the page only adds the time
// since serverNow while `connected`.

import { NextRequest } from "next/server";
import { PartnerError, getIntegration, getZone, verifySession } from "@/lib/partners/store";
import { liveConnection, participantIdentity } from "@/lib/partners/join";
import { heartbeat, timerSummary, type HeartbeatResult } from "@/lib/partners/attendance";
import { eventStore } from "@/lib/eventStore";
import { fail, ipOf, limit, ok, readJson } from "@/lib/partners/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await limit(`attendance:${ipOf(req)}`, 2400);
    const body = await readJson(req);
    const grant = verifySession(body.session);
    const identity = participantIdentity(grant);
    await limit(`attendance:${identity}`, 30);

    const integration = await getIntegration(grant.integrationId);
    if (!integration || integration.status !== "active") throw new PartnerError(403, "integration_disabled", "This integration is disabled.");
    const zone = await getZone(grant.integrationId, grant.zoneId);
    if (!zone || zone.status !== "active") throw new PartnerError(403, "zone_disabled", "This zone's meeting is switched off.");
    if (zone.eventId !== grant.eventId) throw new PartnerError(409, "zone_moved", "This zone now has another meeting. Reload the page.");

    let beat: HeartbeatResult | null = null;
    const sid = typeof body.sid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.sid) ? body.sid : null;
    if (sid) {
      const ev = await eventStore.byId(grant.eventId);
      if (!ev) throw new PartnerError(404, "meeting_not_found", "This meeting no longer exists.");
      const room = ev.livekitRoom || ev.slug;
      beat = await heartbeat(
        { integrationId: grant.integrationId, zoneId: grant.zoneId, eventId: ev.id, room },
        identity,
        sid,
        { integrationId: grant.integrationId, zoneId: grant.zoneId, ext: grant.externalUserId, name: grant.verified ? grant.displayName : `${grant.displayName} (guest)`, verified: grant.verified },
        () => liveConnection(room, identity, sid),
      );
    }
    return ok({ ...(await timerSummary(grant.integrationId, grant.zoneId, identity)), beat });
  } catch (e) {
    return fail(e);
  }
}

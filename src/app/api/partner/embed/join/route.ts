// POST /api/partner/embed/join — the embed page joins its zone's meeting,
// or learns what it is waiting for (waiting room, a host). Called again
// every few seconds while waiting.
//
//   { session }  →  { status: "ready", token, wsUrl, title, displayName }
//                 |  { status: "waiting_room" | "wait_for_host" | "denied", title }

import { NextRequest } from "next/server";
import { PartnerError, getIntegration, getZone, verifySession } from "@/lib/partners/store";
import { joinZone } from "@/lib/partners/join";
import { fail, ipOf, limit, ok, readJson } from "@/lib/partners/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await limit(`join:${ipOf(req)}`, 240);
    const body = await readJson(req);
    const grant = verifySession(body.session);
    // Switched off since the session began: no further joins.
    const integration = await getIntegration(grant.integrationId);
    if (!integration || integration.status !== "active") throw new PartnerError(403, "integration_disabled", "This integration is disabled.");
    const zone = await getZone(grant.integrationId, grant.zoneId);
    if (!zone || zone.status !== "active") throw new PartnerError(403, "zone_disabled", "This zone's meeting is switched off.");
    if (zone.eventId !== grant.eventId) throw new PartnerError(409, "zone_moved", "This zone now has another meeting. Reload the page.");
    return ok(await joinZone(grant));
  } catch (e) {
    return fail(e);
  }
}

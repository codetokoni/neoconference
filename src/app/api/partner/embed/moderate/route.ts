// POST /api/partner/embed/moderate — a zone leader mutes people from the embed.
//
//   { session, action: "mute", identity }  →  { muted }
//   { session, action: "mute-all" }        →  { muted, skipped }
//
// Who may, and whom, is in src/lib/partners/moderation.ts: the zone's
// leaders and the organisation's administrators, checked on every request.

import { NextRequest } from "next/server";
import { PartnerError, getIntegration, getZone, verifySession } from "@/lib/partners/store";
import { participantIdentity } from "@/lib/partners/join";
import { muteAll, muteOne } from "@/lib/partners/moderation";
import { fail, ipOf, limit, ok, readJson } from "@/lib/partners/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await limit(`moderate:${ipOf(req)}`, 600);
    const body = await readJson(req);
    const grant = verifySession(body.session);
    await limit(`moderate:${participantIdentity(grant)}`, 60);

    const integration = await getIntegration(grant.integrationId);
    if (!integration || integration.status !== "active") throw new PartnerError(403, "integration_disabled", "This integration is disabled.");
    const zone = await getZone(grant.integrationId, grant.zoneId);
    if (!zone || zone.status !== "active") throw new PartnerError(403, "zone_disabled", "This zone's meeting is switched off.");
    if (zone.eventId !== grant.eventId) throw new PartnerError(409, "zone_moved", "This zone now has another meeting. Reload the page.");

    if (body.action === "mute") return ok(await muteOne(grant, body.identity));
    if (body.action === "mute-all") return ok(await muteAll(grant));
    throw new PartnerError(400, "invalid_action", "Say mute or mute-all.");
  } catch (e) {
    return fail(e);
  }
}

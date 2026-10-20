// POST /api/partner/embed/redeem — the embed page trades a one-time code
// for its meeting session.
//
//   { code, parentOrigin }  →  { session, meeting: { title }, participant: { name, verified } }
//
// parentOrigin is the origin of the page that handed the code over, as the
// browser reported it on the postMessage (event.origin), not anything the
// partner wrote. It must be the origin the code was issued for, and that
// origin must still be approved for the integration. A code from an
// open-in-new-tab hand-off is redeemed by this site's own page instead.

import { NextRequest } from "next/server";
import { PartnerError, getIntegration, getZone, redeemCode, signSession } from "@/lib/partners/store";
import { fail, ipOf, limit, ok, readJson } from "@/lib/partners/http";
import { linkOrigin, isOwnHost } from "@/lib/brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await limit(`redeem:${ipOf(req)}`, 60);
    const body = await readJson(req);
    const grant = await redeemCode(body.code);

    const integration = await getIntegration(grant.integrationId);
    if (!integration || integration.status !== "active") throw new PartnerError(403, "integration_disabled", "This integration is disabled.");

    if (grant.origin === "self") {
      // A new tab of this site: the request comes from one of our own pages.
      const from = req.headers.get("origin");
      let host = "";
      try {
        host = from ? new URL(from).host : "";
      } catch {
        host = "";
      }
      if (!from || !(isOwnHost(host) || from === linkOrigin(req))) {
        throw new PartnerError(403, "origin_mismatch", "This code can only be used on this site.");
      }
    } else if (body.parentOrigin !== grant.origin || !integration.origins.includes(grant.origin)) {
      throw new PartnerError(403, "origin_mismatch", "This meeting can only be opened on the website it was issued for.");
    }

    const zone = await getZone(grant.integrationId, grant.zoneId);
    return ok({
      session: signSession(grant),
      meeting: { title: zone?.title ?? grant.zoneId, zoneId: grant.zoneId },
      participant: { name: grant.displayName, verified: grant.verified },
    });
  } catch (e) {
    return fail(e);
  }
}

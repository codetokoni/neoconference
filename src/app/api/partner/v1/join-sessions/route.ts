// POST /api/partner/v1/join-sessions — the partner's BACKEND asks for a
// one-time join code for one of its visitors in one of its zones.
//
//   Authorization: Bearer nlm_pk_…        (the integration's secret; server-side only)
//   { "zoneId": "FALF",
//     "user": { "id": "u_123", "displayName": "Victor Agbasa" },   // or { "guest": true, "displayName": "…" }
//     "origin": "https://herald.prayerclouds.org",                  // the page the widget runs on
//     "zoneTitle": "FALF Prayer Meeting" }                          // optional, used when the zone is first made
//   → 201 { code, expiresAt, meeting: { zoneId, title }, embed: { page, sdk } }
//
// The integration comes from its key, never from the body. Everyone is a
// participant: no field here can make anyone a host. The code is good for
// two minutes and one use, and only from `origin` (the iframe proves which
// page it is on when it redeems it). docs/integrations/partner-zones.md.

import { NextRequest } from "next/server";
import { linkOrigin } from "@/lib/brand";
import {
  PartnerError,
  authenticatePartner,
  cleanName,
  cleanUserId,
  issueCode,
  normalizeOrigin,
  normalizeZone,
  resolveZone,
  audit,
} from "@/lib/partners/store";
import { fail, limit, ok, readJson } from "@/lib/partners/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { integration, keyId } = await authenticatePartner(req.headers.get("authorization"));
    await limit(`key:${keyId}`, 600);
    const body = await readJson(req);

    const zoneId = normalizeZone(body.zoneId);
    if (!zoneId) throw new PartnerError(400, "invalid_zone", "zoneId: letters, digits, - and _, up to 40.");
    await limit(`zone:${integration.id}:${zoneId}`, 300);

    const origin = normalizeOrigin(body.origin);
    if (!origin) throw new PartnerError(400, "invalid_origin", "origin: the https origin of the page the widget runs on.");
    if (!integration.origins.includes(origin)) {
      throw new PartnerError(403, "origin_not_approved", "This website is not approved for this integration.");
    }

    const user = (body.user && typeof body.user === "object" ? body.user : {}) as Record<string, unknown>;
    const displayName = cleanName(user.displayName);
    if (!displayName) throw new PartnerError(400, "invalid_name", "user.displayName: 1 to 60 characters.");
    let externalUserId: string;
    let verified: boolean;
    if (user.guest === true) {
      if (!integration.guestAccess) throw new PartnerError(403, "guests_not_allowed", "This integration does not admit guests.");
      // A guest's id is the partner's id for the visit if it has one, else this code's own.
      externalUserId = `guest:${cleanUserId(user.id) ?? cryptoId()}`;
      verified = false;
    } else {
      const id = cleanUserId(user.id);
      if (!id) throw new PartnerError(400, "invalid_user", "user.id: the partner's stable id for this person.");
      externalUserId = `user:${id}`;
      verified = true;
    }

    const { mapping } = await resolveZone(integration, zoneId);
    const { code, expiresAt } = await issueCode({
      integrationId: integration.id,
      zoneId,
      eventId: mapping.eventId,
      origin,
      externalUserId,
      displayName,
      verified,
      role: "participant",
    });
    void audit(integration.id, "session.issue", `key:${keyId}`, { zone: zoneId, verified });

    const site = linkOrigin(req);
    return ok(
      {
        code,
        expiresAt,
        meeting: { zoneId, title: mapping.title },
        embed: { page: `${site}/embed/zone`, sdk: `${site}/widget/v1.js` },
      },
      201,
    );
  } catch (e) {
    return fail(e);
  }
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

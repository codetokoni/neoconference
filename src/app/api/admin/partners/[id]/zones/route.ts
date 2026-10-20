// POST /api/admin/partners/[id]/zones (integrations:write + fresh code):
// point a zone at an existing meeting, by its address — a zone no partner
// visit has made yet (automatic zones off), or a zone moved to another
// meeting. Visitors already in a session are told to reload.
//
//   { zoneId, meeting }   meeting: the slug, or a link ending in it

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { readJson } from "@/lib/admin/http";
import { adminFail, meetingSlug } from "@/lib/partners/admin";
import { PartnerError, connectZone, getIntegration, getZone, normalizeZone } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  try {
    const integration = await getIntegration(params.id);
    if (!integration) throw new PartnerError(404, "integration_not_found", "No such integration.");
    const body = (await readJson(req)) ?? {};
    const zone = normalizeZone(body.zoneId);
    if (!zone) throw new PartnerError(400, "invalid_zone", "Zone ids are letters, digits, - and _ (up to 40).");
    const before = await getZone(integration.id, zone);
    const mapping = await connectZone(integration, zone, meetingSlug(body.meeting), g.ctx.email);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "partner.zone.connect",
      targetType: "partner_zone",
      targetId: `${integration.id}:${zone}`,
      targetLabel: `${integration.name} / ${zone}`,
      before: before ? { meeting: before.slug } : null,
      after: { meeting: mapping.slug },
    });
    return NextResponse.json({ ok: true, zone: mapping });
  } catch (e) {
    return adminFail(e);
  }
}

// PATCH /api/admin/partners/[id]/zones/[zone] (integrations:write + fresh
// code): switch a zone's meeting off or on ({ status }), or give it to
// another account ({ ownerEmail }; that account's plan then sets its
// limits).

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { readJson } from "@/lib/admin/http";
import { accountByEmail, adminFail } from "@/lib/partners/admin";
import { PartnerError, getIntegration, getZone, normalizeZone, setZoneOwner, setZoneStatus } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string; zone: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  try {
    const integration = await getIntegration(params.id);
    if (!integration) throw new PartnerError(404, "integration_not_found", "No such integration.");
    const zone = normalizeZone(decodeURIComponent(params.zone));
    const before = zone ? await getZone(integration.id, zone) : null;
    if (!zone || !before) throw new PartnerError(404, "zone_not_found", "No such zone.");
    const body = (await readJson(req)) ?? {};
    const target = { targetType: "partner_zone", targetId: `${integration.id}:${zone}`, targetLabel: `${integration.name} / ${zone}` };

    if ("status" in body) {
      if (body.status !== "active" && body.status !== "disabled") throw new PartnerError(400, "invalid_status", "Status is active or disabled.");
      const next = await setZoneStatus(integration.id, zone, body.status, g.ctx.email);
      await recordAdminAction(actorOf(g.ctx), req, {
        action: body.status === "active" ? "partner.zone.enable" : "partner.zone.disable",
        ...target,
        before: { status: before.status },
        after: { status: next.status },
      });
      return NextResponse.json({ ok: true, zone: next });
    }
    if ("ownerEmail" in body) {
      const owner = await accountByEmail(body.ownerEmail);
      const next = await setZoneOwner(integration.id, zone, owner.userId, owner.email, g.ctx.email);
      await recordAdminAction(actorOf(g.ctx), req, {
        action: "partner.zone.owner",
        ...target,
        before: { ownerUserId: before.ownerUserId },
        after: { ownerUserId: next.ownerUserId, ownerEmail: owner.email },
      });
      return NextResponse.json({ ok: true, zone: next });
    }
    throw new PartnerError(400, "nothing_to_change", "Nothing to change.");
  } catch (e) {
    return adminFail(e);
  }
}

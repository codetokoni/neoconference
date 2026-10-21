// PUT /api/admin/partners/[id]/roles (integrations:write + fresh code):
// { orgAdmins: [partner user ids] } — who reads every zone's prayer reports
// and the organisation report. The partner's server can set the same list
// (PUT /api/partner/v1/roles).

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { readJson } from "@/lib/admin/http";
import { adminFail } from "@/lib/partners/admin";
import { PartnerError, getIntegration, getOrgAdmins, setOrgAdmins } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  try {
    const integration = await getIntegration(params.id);
    if (!integration) throw new PartnerError(404, "integration_not_found", "No such integration.");
    const before = await getOrgAdmins(integration.id);
    const orgAdmins = await setOrgAdmins(integration.id, ((await readJson(req)) ?? {}).orgAdmins, g.ctx.email);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "partner.roles",
      targetType: "partner_integration",
      targetId: integration.id,
      targetLabel: integration.name,
      before: { orgAdmins: before },
      after: { orgAdmins },
    });
    return NextResponse.json({ ok: true, orgAdmins });
  } catch (e) {
    return adminFail(e);
  }
}

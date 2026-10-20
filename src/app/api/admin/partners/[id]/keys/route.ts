// POST /api/admin/partners/[id]/keys (integrations:write + fresh code): a
// new secret key for the partner's backend, answered once. Older keys keep
// working until revoked, so a partner can switch without downtime.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { adminFail } from "@/lib/partners/admin";
import { PartnerError, getIntegration, mintPartnerKey } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  try {
    const integration = await getIntegration(params.id);
    if (!integration) throw new PartnerError(404, "integration_not_found", "No such integration.");
    const { meta, raw } = await mintPartnerKey(integration.id, g.ctx.email);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "partner.key.create",
      targetType: "partner_integration",
      targetId: integration.id,
      targetLabel: `${integration.name}: ${meta.masked}`,
      after: { key: meta.masked },
    });
    return NextResponse.json({ ok: true, key: meta, secret: raw }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return adminFail(e);
  }
}

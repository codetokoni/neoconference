// DELETE /api/admin/partners/[id]/keys/[keyId] (integrations:write + fresh
// code): revoke a partner key. Codes it already issued still expire on
// their own (two minutes); no new ones can be made with it.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { adminFail } from "@/lib/partners/admin";
import { PartnerError, getIntegration, listPartnerKeys, revokePartnerKey } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: { id: string; keyId: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  try {
    const integration = await getIntegration(params.id);
    if (!integration) throw new PartnerError(404, "integration_not_found", "No such integration.");
    const key = (await listPartnerKeys(params.id)).find((k) => k.id === params.keyId);
    if (!key) throw new PartnerError(404, "key_not_found", "No such key.");
    await revokePartnerKey(params.id, params.keyId, g.ctx.email);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "partner.key.revoke",
      targetType: "partner_integration",
      targetId: integration.id,
      targetLabel: `${integration.name}: ${key.masked}`,
      before: { revoked: !!key.revokedAt },
      after: { revoked: true },
    });
    return NextResponse.json({ ok: true, revoked: params.keyId });
  } catch (e) {
    return adminFail(e);
  }
}

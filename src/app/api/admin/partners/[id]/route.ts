// GET   /api/admin/partners/[id] (integrations:write, read-only): the
//       integration, its keys (masked), its zones and its own audit trail.
// PATCH /api/admin/partners/[id] (integrations:write + fresh code): change
//       name, owner (by email), approved websites, automatic zones, guest
//       access, the meeting title, or switch it on or off.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { readJson } from "@/lib/admin/http";
import { adminFail, changes, integrationDetail, readPatch } from "@/lib/partners/admin";
import { PartnerError, getIntegration, updateIntegration } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "integrations:write", { readOnly: true });
  if (!g.ok) return g.response;
  try {
    return NextResponse.json({ ok: true, ...(await integrationDetail(params.id)) });
  } catch (e) {
    return adminFail(e);
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  try {
    const before = await getIntegration(params.id);
    if (!before) throw new PartnerError(404, "integration_not_found", "No such integration.");
    const patch = await readPatch((await readJson(req)) ?? {});
    const integration = await updateIntegration(params.id, patch, g.ctx.email);
    const switched = patch.status && patch.status !== before.status;
    await recordAdminAction(actorOf(g.ctx), req, {
      action: switched ? (patch.status === "active" ? "partner.enable" : "partner.disable") : "partner.update",
      targetType: "partner_integration",
      targetId: integration.id,
      targetLabel: integration.name,
      ...changes(before, patch),
    });
    return NextResponse.json({ ok: true, integration });
  } catch (e) {
    return adminFail(e);
  }
}

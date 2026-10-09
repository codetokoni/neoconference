// /api/admin/ops/incidents/<id> (ops:write)
//
// PATCH { status?, message?, impact?, showBanner? } posts an update to the
// timeline; "resolved" closes it and takes it off the site notice. Audited.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { getIncident, isImpact, isIncidentStatus, updateIncident } from "@/lib/ops/incidents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "ops:write");
  if (!g.ok) return g.response;
  const before = await getIncident(params.id);
  if (!before) return fail("not_found", "No such incident.", 404);
  const b = await readJson<Record<string, unknown>>(req);
  const status = isIncidentStatus(b?.status) ? b!.status : undefined;
  const impact = isImpact(b?.impact) ? b!.impact : undefined;
  const message = str(b?.message, 1000) || undefined;
  const showBanner = typeof b?.showBanner === "boolean" ? b.showBanner : undefined;
  if (!status && !impact && !message && showBanner === undefined) return fail("nothing_to_change", "Post an update or change the status.");
  const after = await updateIncident(params.id, { status, impact, message, showBanner, by: g.ctx.email });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "ops.incident.update",
    targetType: "incident",
    targetId: params.id,
    targetLabel: before.title,
    before: { status: before.status, impact: before.impact, showBanner: before.showBanner },
    after: { status: after?.status, impact: after?.impact, showBanner: after?.showBanner, ...(message ? { message } : {}), banner: after?.banner },
  });
  return NextResponse.json({ ok: true, incident: after });
}

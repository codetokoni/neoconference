// /api/admin/ops/maintenance/<id>
//
// DELETE cancels a scheduled or running window: its notice comes down and,
// if it turned maintenance mode on, maintenance mode goes off. ops:write,
// plus features:write when the window uses maintenance mode. Audited.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { cancelMaintenance, getMaintenance } from "@/lib/ops/incidents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function DELETE(req: Request, { params }: Params) {
  const before = await getMaintenance(params.id);
  const g = await requireAdmin(req, before?.maintenanceMode ? ["ops:write", "features:write"] : "ops:write");
  if (!g.ok) return g.response;
  if (!before) return fail("not_found", "No such maintenance window.", 404);
  const after = await cancelMaintenance(params.id, g.ctx.email);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "ops.maintenance.cancel",
    targetType: "maintenance",
    targetId: params.id,
    targetLabel: before.title,
    before: { state: before.state },
    after: { state: after?.state, surface: after?.surface },
  });
  return NextResponse.json({ ok: true, window: after });
}

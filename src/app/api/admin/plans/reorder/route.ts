// POST /api/admin/plans/reorder (plans:write) { ids: string[] } — the order
// plans are listed in, here and on /pricing.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { listPlans, reorderPlans } from "@/lib/billing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const body = await readJson<{ ids?: unknown }>(req);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
  const before = (await listPlans()).map((p) => p.id);
  if (!ids.length || ids.some((id) => !before.includes(id))) return fail("bad_order", "Send the plan ids in the order you want.");
  const after = (await reorderPlans(ids)).map((p) => p.id);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "plan.reorder",
    targetType: "plan",
    targetId: "*",
    targetLabel: "plan order",
    before: { order: before },
    after: { order: after },
  });
  return NextResponse.json({ ok: true, order: after });
}

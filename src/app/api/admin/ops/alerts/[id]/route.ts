// /api/admin/ops/alerts/<id> (ops:write)
//
// PATCH { action: "acknowledge" }            stops it looking new; stays open
// PATCH { action: "resolve", note? }         closes it
// Audited.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { acknowledgeAlert, getAlert, resolveAlert } from "@/lib/ops/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "ops:write");
  if (!g.ok) return g.response;
  const before = await getAlert(params.id);
  if (!before) return fail("not_found", "No such alert.", 404);
  const b = await readJson<{ action?: unknown; note?: unknown }>(req);
  const note = str(b?.note, 300);
  let after;
  if (b?.action === "acknowledge") after = await acknowledgeAlert(params.id, g.ctx.email);
  else if (b?.action === "resolve") after = await resolveAlert(params.id, g.ctx.email, note || undefined);
  else return fail("bad_action", "Say acknowledge or resolve.");
  await recordAdminAction(actorOf(g.ctx), req, {
    action: `ops.alert.${b.action}`,
    targetType: "alert",
    targetId: params.id,
    targetLabel: before.title,
    before: { status: before.status },
    after: { status: after?.status, ...(note ? { note } : {}) },
  });
  return NextResponse.json({ ok: true, alert: after });
}

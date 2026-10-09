// PATCH /api/admin/addons/[id] (plans:write) — edit, or { archived: true }.
// Subscriptions keep the grants of the add-on as it was when attached.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { cleanAddOn, strip } from "@/lib/billing/adminInput";
import { getAddOn, saveAddOn } from "@/lib/billing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const existing = await getAddOn(params.id);
  if (!existing) return fail("not_found", "That add-on was not found.", 404);
  const body = await readJson(req);
  if (!body) return fail("bad_request", "Send the change as JSON.");
  const next = cleanAddOn(body, existing, g.ctx.email);
  if (typeof next === "string") return fail("bad_addon", next);
  const change = diff(strip(existing) as Record<string, unknown>, strip(next) as Record<string, unknown>);
  if (!Object.keys(change.after).length) return NextResponse.json({ ok: true, addOn: existing, unchanged: true });
  await saveAddOn(next);
  await recordAdminAction(actorOf(g.ctx), req, { action: "addon.update", targetType: "addon", targetId: next.id, targetLabel: next.name, before: change.before, after: change.after });
  return NextResponse.json({ ok: true, addOn: next });
}

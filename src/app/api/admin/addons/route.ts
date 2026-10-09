// /api/admin/addons — extras an administrator attaches to a subscription
// (more participants, recording hours, members, a feature switched on).
// Attached from the subscription screen; there is no self-serve purchase
// of add-ons yet, so their prices are what to charge off-band.
//
// GET  (plans:read)
// POST (plans:write)  { name, description, prices, grants, planIds[] }

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { cleanAddOn, strip } from "@/lib/billing/adminInput";
import { listAddOns, saveAddOn } from "@/lib/billing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "plans:read");
  if (!g.ok) return g.response;
  return NextResponse.json({ ok: true, addOns: await listAddOns() });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const body = await readJson(req);
  if (!body) return fail("bad_request", "Send the add-on as JSON.");
  const a = cleanAddOn(body, null, g.ctx.email);
  if (typeof a === "string") return fail("bad_addon", a);
  await saveAddOn(a);
  await recordAdminAction(actorOf(g.ctx), req, { action: "addon.create", targetType: "addon", targetId: a.id, targetLabel: a.name, after: strip(a) });
  return NextResponse.json({ ok: true, addOn: a }, { status: 201 });
}

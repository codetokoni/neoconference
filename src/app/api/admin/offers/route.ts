// /api/admin/offers — promotional offers: a discount with no code, taken
// off at eSPees checkout while it runs, and labelled on /pricing.
//
// GET  (plans:read)
// POST (plans:write)  { name, label, kind: percent|fixed, value, planIds[],
//                       cycles[], startsAt, endsAt, active }
//
// An offer and a coupon do not stack: checkout takes the larger discount.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { cleanOffer, strip } from "@/lib/billing/adminInput";
import { listOffers, saveOffer } from "@/lib/billing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "plans:read");
  if (!g.ok) return g.response;
  return NextResponse.json({ ok: true, offers: await listOffers() });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const body = await readJson(req);
  if (!body) return fail("bad_request", "Send the offer as JSON.");
  const o = cleanOffer(body, null, g.ctx.email);
  if (typeof o === "string") return fail("bad_offer", o);
  await saveOffer(o);
  await recordAdminAction(actorOf(g.ctx), req, { action: "offer.create", targetType: "offer", targetId: o.id, targetLabel: o.name, after: strip(o) });
  return NextResponse.json({ ok: true, offer: o }, { status: 201 });
}

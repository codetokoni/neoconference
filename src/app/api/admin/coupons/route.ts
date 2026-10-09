// /api/admin/coupons — coupon codes for eSPees checkout.
//
// GET  (plans:read)   every coupon with its redemption count
// POST (plans:write)  { code, description, kind: percent|fixed, value,
//                       planIds[], cycles[], startsAt, expiresAt,
//                       maxRedemptions, oncePerUser, active }
//
// A coupon is redeemed when its payment comes back paid (the eSPees return
// route); src/lib/billing/checkout.ts checks it at checkout.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { cleanCoupon, strip } from "@/lib/billing/adminInput";
import { getCoupon, listCoupons, saveCoupon } from "@/lib/billing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "plans:read");
  if (!g.ok) return g.response;
  return NextResponse.json({ ok: true, coupons: await listCoupons() });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const body = await readJson(req);
  if (!body) return fail("bad_request", "Send the coupon as JSON.");
  const c = cleanCoupon(body, null, g.ctx.email);
  if (typeof c === "string") return fail("bad_coupon", c);
  if (await getCoupon(c.code)) return fail("code_taken", `There is already a coupon ${c.code}.`, 409);
  await saveCoupon(c);
  await recordAdminAction(actorOf(g.ctx), req, { action: "coupon.create", targetType: "coupon", targetId: c.code, targetLabel: c.code, after: strip(c) });
  return NextResponse.json({ ok: true, coupon: { ...c, redemptions: 0 } }, { status: 201 });
}

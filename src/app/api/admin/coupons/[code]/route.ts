// /api/admin/coupons/[code] (plans:write)
//
// PATCH   any coupon field but the code; { active: false } switches it off
// DELETE  only a coupon nobody has redeemed — a used one is switched off
//         instead, so the payments that used it still say which it was

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { cleanCoupon, strip } from "@/lib/billing/adminInput";
import { couponRedemptions, deleteCoupon, getCoupon, saveCoupon } from "@/lib/billing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { code: string } };

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const existing = await getCoupon(params.code);
  if (!existing) return fail("not_found", "That coupon was not found.", 404);
  const body = await readJson(req);
  if (!body) return fail("bad_request", "Send the change as JSON.");
  const next = cleanCoupon(body, existing, g.ctx.email);
  if (typeof next === "string") return fail("bad_coupon", next);
  const change = diff(strip(existing) as Record<string, unknown>, strip(next) as Record<string, unknown>);
  if (!Object.keys(change.after).length) return NextResponse.json({ ok: true, coupon: existing, unchanged: true });
  await saveCoupon(next);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "coupon.update",
    targetType: "coupon",
    targetId: next.code,
    targetLabel: next.code,
    before: change.before,
    after: change.after,
  });
  return NextResponse.json({ ok: true, coupon: { ...next, redemptions: await couponRedemptions(next.code) } });
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const existing = await getCoupon(params.code);
  if (!existing) return fail("not_found", "That coupon was not found.", 404);
  const used = await couponRedemptions(existing.code);
  if (used > 0) return fail("coupon_used", `${existing.code} has been redeemed ${used} time(s). Switch it off instead.`, 409);
  await deleteCoupon(existing.code);
  await recordAdminAction(actorOf(g.ctx), req, { action: "coupon.delete", targetType: "coupon", targetId: existing.code, targetLabel: existing.code, before: strip(existing) });
  return NextResponse.json({ ok: true });
}

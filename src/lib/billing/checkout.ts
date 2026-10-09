// src/lib/billing/checkout.ts
//
// What eSPees checkout charges: the plan's current ESP price from the
// catalog, less the best of the coupon entered and any promotional offer
// running (they do not stack). A coupon is counted as redeemed when the
// payment comes back paid, not when checkout starts, so an abandoned
// checkout does not use one up; a few checkouts in flight at once can
// therefore take a coupon past its limit by that many.

import {
  MIN_CHARGE_ESP,
  couponProblem,
  discounted,
  espPrice,
  offerApplies,
  type CatalogPlan,
  type Coupon,
  type Cycle,
  type Offer,
} from "@/lib/billing/model";
import { couponRedemptions, couponUsedBy, getCoupon, getPlan, listOffers } from "@/lib/billing/store";

export type Quote =
  | {
      ok: true;
      plan: CatalogPlan;
      cycle: Cycle;
      listPriceEsp: number;
      discountEsp: number;
      amountEsp: number;
      coupon: Coupon | null;
      offer: Offer | null;
    }
  | { ok: false; status: number; error: string; message: string };

export async function quoteCheckout(input: { planId: string; cycle: Cycle; couponCode?: string | null; userId: string; now?: number }): Promise<Quote> {
  const now = input.now ?? Date.now();
  const plan = await getPlan(input.planId);
  if (!plan || plan.archived || !plan.selfServe || plan.baseTier === "free") {
    return { ok: false, status: 400, error: "invalid_plan", message: "That plan cannot be bought online." };
  }
  const list = espPrice(plan.current.prices, input.cycle);
  if (!list) return { ok: false, status: 400, error: "invalid_billing_cycle", message: `${plan.current.name} is not sold ${input.cycle}.` };

  let best: { discount: number; coupon: Coupon | null; offer: Offer | null } = { discount: 0, coupon: null, offer: null };
  const code = (input.couponCode || "").trim().toUpperCase();
  if (code) {
    const c = await getCoupon(code);
    if (!c) return { ok: false, status: 400, error: "invalid_coupon", message: "There is no coupon with that code." };
    const problem = couponProblem(c, {
      planId: plan.id,
      cycle: input.cycle,
      now,
      redemptions: await couponRedemptions(c.code),
      usedByUser: await couponUsedBy(c.code, input.userId),
    });
    if (problem) return { ok: false, status: 400, error: "invalid_coupon", message: problem };
    best = { discount: discounted(list, c).discount, coupon: c, offer: null };
  }
  for (const o of await listOffers()) {
    if (!offerApplies(o, plan.id, input.cycle, now)) continue;
    const d = discounted(list, o).discount;
    if (d > best.discount) best = { discount: d, coupon: null, offer: o };
  }
  const amount = Math.round((list - best.discount) * 100) / 100;
  if (amount < MIN_CHARGE_ESP) {
    return {
      ok: false,
      status: 400,
      error: "below_minimum",
      message: `With that discount the price would be ${amount} ESP; eSPees needs at least ${MIN_CHARGE_ESP} ESP. For a free period an administrator can grant a complimentary plan.`,
    };
  }
  return { ok: true, plan, cycle: input.cycle, listPriceEsp: list, discountEsp: best.discount, amountEsp: amount, coupon: best.coupon, offer: best.offer };
}

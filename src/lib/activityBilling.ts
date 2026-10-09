// src/lib/activityBilling.ts
//
// Subscription changes (src/lib/billing/subscriptions.ts) in the activity
// log, so Analytics can count conversions, cancellations and plans ending.
// Called once from that module's persist(), which every change goes through:
// a purchase, an administrator's action, the daily sweep. Never throws.

import { record } from "@/lib/activity";
import type { Subscription } from "@/lib/billing/model";

type Before = Pick<Subscription, "planId" | "status"> | null | undefined;

/** The plan someone had before: "free" when they had nothing current. */
export function planBefore(before: Before): string {
  if (!before || before.status === "expired") return "free";
  return before.planId;
}

export async function recordSubscriptionChange(
  action: string,
  before: Before,
  after: Subscription,
  by: { userId: string; email: string },
): Promise<void> {
  const from = planBefore(before);
  const admin = action.startsWith("admin.") ? { by: by.email } : {};
  if (action === "purchase" || action === "purchase.renew") {
    await record("plan.purchased", {
      userId: after.userId,
      props: { from, to: after.planId, cycle: after.cycle, amountEsp: after.pricePaid?.amount ?? null, renewal: action === "purchase.renew" },
    });
  } else if (action === "admin.cancel") {
    await record("plan.cancelled", { userId: after.userId, props: { from, ends: after.endedAt ? "now" : "period_end", ...admin } });
  } else if (action === "expire") {
    const reason = before?.status === "trialing" ? "trial_ended" : before?.status === "cancelled" ? "cancelled" : "period_ended";
    await record("plan.downgraded", { userId: after.userId, props: { from, to: "free", reason } });
  } else if (action.startsWith("admin.")) {
    await record("plan.changed", { userId: after.userId, props: { action: action.slice(6), from, to: after.planId, status: after.status, ...admin } });
  }
}

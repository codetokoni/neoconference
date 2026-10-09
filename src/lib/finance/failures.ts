// src/lib/finance/failures.ts
//
// Failed payments, which nothing recorded before: a payment record with
// status "failed" for an eSPees checkout that came back through the fail
// URL (cancelled or declined on the eSPees page), and a ticket record with
// status "failed" for a Stripe payment that failed (ledger.ts). They show in
// the admin's failed-payment figures and drive the failed-payment reminder.
// A failed record took no money: it has no invoice and adds to no revenue.

import { recordPayment, updatePaymentRecord } from "@/lib/paymentsStore";
import type { Plan } from "@/lib/plan";
import type { BillingCycle } from "@/lib/espees";

export interface PendingLike {
  nonce: string;
  userId: string;
  plan: string;
  billingCycle: BillingCycle;
  paymentRef?: string;
  amountEsp?: number;
}

/**
 * Record a checkout the buyer did not complete at eSPees. Idempotent by
 * payment reference, like every payment record. Never throws.
 */
export async function recordFailedCheckout(p: PendingLike, opts: { country?: string | null; reason?: string } = {}): Promise<void> {
  try {
    const { ESPEES_AMOUNTS } = await import("@/lib/espees");
    const amount =
      typeof p.amountEsp === "number"
        ? p.amountEsp
        : ((ESPEES_AMOUNTS as Record<string, Record<string, number> | undefined>)[p.plan]?.[p.billingCycle] ?? 0);
    const paymentRef = p.paymentRef?.trim() || `nonce-${p.nonce}`;
    const now = Date.now();
    const { created } = await recordPayment({
      paymentRef,
      userId: p.userId,
      plan: p.plan as Plan,
      billingCycle: p.billingCycle,
      amountEsp: amount,
      status: "failed",
      paidAt: now,
      periodStart: now,
      periodEnd: now,
      source: "espees-redirect-unverified",
    });
    if (created) {
      await updatePaymentRecord(paymentRef, {
        failureReason: opts.reason ?? "Not completed at eSPees (cancelled or declined).",
        ...(opts.country ? { country: opts.country } : {}),
      });
    }
  } catch (err) {
    console.error("[billing] could not record a failed payment", err);
  }
}

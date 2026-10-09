// src/app/api/billing/espees/return/route.ts
//
// GET /api/billing/espees/return?nonce=<hex>
//
// eSPees redirects the user here after a successful payment. We:
//   1. Look up the pending KV record by nonce.
//   2. If pending, mark it paid and write plan to Clerk publicMetadata.
//   3. Persist a permanent PaymentRecord in paymentsStore (Task 1 of
//      docs/BILLING-HANDOFF.md — the billingStore record disappears in
//      ~1 hour and can't back a billing page or an invoice).
//   4. Append an audit-log entry (Task 1 mitigation for the unverified-
//      upgrade hole, §2 of the handoff).
//   5. Redirect the browser to /dashboard?upgraded=<plan>.
//
// Honest gap: without an eSPees server-to-server webhook, we cannot
// independently verify the payment cleared. v1 trusts the redirect; we
// stamp source: "espees-redirect-unverified" on every grant so proven
// and assumed can be told apart later. We will not silently extend the
// pending TTL as a "fix" — that would widen the exploit window.

import { NextResponse } from "next/server";
import { readPendingPayment, updatePaymentStatus, type PendingPayment } from "@/lib/billingStore";
import { isAppCallback, redirectToApp } from "@/lib/app-callback";
import { ESPEES_AMOUNTS } from "@/lib/espees";
import { recordPayment, updatePaymentRecord } from "@/lib/paymentsStore";
import { applyPurchase } from "@/lib/billing/subscriptions";
import { redeemCoupon } from "@/lib/billing/store";

/**
 * Where to send the buyer once the upgrade has landed.
 *
 * A purchase started in the mobile app opened this page in the phone's
 * browser, so the ordinary redirect to /dashboard would leave them looking
 * at a web page with no way back. `returnTo` is set only by the checkout
 * route, and only ever to the app's one App Link, so this cannot become an
 * open redirect that fires after a payment.
 */
function upgradedRedirect(origin: string, record: PendingPayment) {
  if (isAppCallback(record.returnTo)) {
    return redirectToApp({ upgraded: record.plan });
  }
  return NextResponse.redirect(origin + "/dashboard?upgraded=" + record.plan, {
    status: 303,
  });
}
import { appendAuditEntry } from "@/lib/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function siteOrigin(req: Request): string {
  return new URL(req.url).origin;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nonce = (url.searchParams.get("nonce") || "").trim();
  const origin = siteOrigin(req);

  if (!nonce) {
    return NextResponse.redirect(origin + "/pricing?error=missing_nonce", { status: 303 });
  }

  const record = await readPendingPayment(nonce);
  if (!record) {
    return NextResponse.redirect(origin + "/pricing?error=expired_or_unknown", { status: 303 });
  }

  if (record.status === "paid") {
    // Idempotent: a refresh on the success page should not error.
    return upgradedRedirect(origin, record);
  }

  if (record.status !== "pending") {
    return NextResponse.redirect(origin + "/pricing?error=already_resolved", { status: 303 });
  }

  // What was paid: the catalog price the checkout charged (after any
  // coupon or offer). A record from before the catalog has no amount and
  // was sold at the tier's built-in price.
  const amountEsp =
    record.amountEsp ??
    (record.plan === "starter" || record.plan === "pro" || record.plan === "business"
      ? ESPEES_AMOUNTS[record.plan][record.billingCycle]
      : 0);

  // Promote the user: the subscription record and Clerk publicMetadata
  // (plan, planExpiresAt, and the limits of the version bought) together.
  // planExpiresAt follows the proration rule in src/lib/billing/model.ts —
  // a renewal starts when the current period ends, a different plan
  // converts the unused days — and is what the daily cron sweeps on.
  let planExpiresAt: number;
  const paidAt = Date.now();
  try {
    const applied = await applyPurchase({
      userId: record.userId,
      planId: record.planId ?? record.plan,
      version: record.planVersion,
      cycle: record.billingCycle,
      amountEsp,
      couponCode: record.couponCode ?? null,
      now: paidAt,
    });
    planExpiresAt = applied.periodEnd;
  } catch (e) {
    console.warn("[espees-return] applying the purchase failed", e);
    // Mark failed so user can retry; surface error to /pricing.
    await updatePaymentStatus(nonce, "failed");
    const msg = encodeURIComponent("clerk_update_failed");
    return NextResponse.redirect(origin + "/pricing?error=" + msg, { status: 303 });
  }

  // Persist the permanent payment record in the same handler that wrote
  // Clerk metadata so the two can never disagree (acceptance criterion 1
  // of the handoff). Idempotent by paymentRef — a refreshed return URL
  // returns the existing record without minting a duplicate or a second
  // invoice number.
  //
  // paymentRef can be missing on the pending record if eSpees returned
  // no payment_ref at checkout time (rare — should only happen in a
  // partial checkout-route failure). Fall back to a stable, unique key
  // derived from the nonce so the payment is still traceable rather
  // than lost. Prefix disambiguates from real eSpees refs.
  const paymentRef = record.paymentRef?.trim() || `nonce-${nonce}`;
  let paymentCreated = false;
  try {
    const result = await recordPayment({
      paymentRef,
      userId: record.userId,
      plan: record.plan,
      billingCycle: record.billingCycle,
      amountEsp,
      status: "paid",
      paidAt,
      periodStart: paidAt,
      // periodEnd MUST equal the planExpiresAt written to Clerk above.
      periodEnd: planExpiresAt,
      source: "espees-redirect-unverified",
      planId: record.planId,
      planVersion: record.planVersion,
      listPriceEsp: record.listPriceEsp,
      couponCode: record.couponCode,
      offerId: record.offerId,
    });
    paymentCreated = result.created;
    // A coupon counts as used once its payment has come back paid.
    if (paymentCreated && record.couponCode) await redeemCoupon(record.couponCode, record.userId);
  } catch (e) {
    // Persistence failure here is non-fatal for the upgrade itself —
    // Clerk metadata is already written and the user has their plan.
    // Log so operators can reconcile after the fact.
    console.warn("[espees-return] recordPayment failed", e);
  }

  // Audit trail (Task 1 mitigation). Fire-and-forget — appendAuditEntry
  // never throws. Only emit on first-time write so a page refresh doesn't
  // spam the log.
  if (paymentCreated) {
    void appendAuditEntry({
      ts: paidAt,
      permission: "billing:upgrade",
      allowed: true,
      userId: record.userId,
      role: "self",
      reason: `espees-redirect-unverified plan=${record.plan} cycle=${record.billingCycle} ref=${paymentRef}`,
    });
  }

  await updatePaymentStatus(nonce, "paid");

  // Where the buyer's connection was (Vercel's geo header), for the tax
  // rule on their invoice. Best effort.
  const country = req.headers.get("x-vercel-ip-country");
  if (paymentCreated && country) await updatePaymentRecord(paymentRef, { country }).catch(() => null);

  return upgradedRedirect(origin, record);
}

// src/app/api/billing/espees/fail/route.ts
//
// GET /api/billing/espees/fail?nonce=<hex>
//
// eSPees redirects the user here when a payment is cancelled or fails.
// We mark the pending KV record as failed and bounce back to /pricing.

import { NextResponse } from "next/server";
import { readPendingPayment, updatePaymentStatus } from "@/lib/billingStore";
import { isAppCallback, redirectToApp } from "@/lib/app-callback";
import { recordFailedCheckout } from "@/lib/finance/failures";
import { readNonce, traceEspees } from "@/lib/espeesTrace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { nonce, shape } = readNonce(url);
  const origin = url.origin;
  let outcome = nonce ? "expired_or_unknown" : "missing_nonce";
  let extra: Record<string, string | number | boolean | null> = {};

  // Read before marking it failed: the record is where we learn whether
  // this purchase started in the mobile app, and a cancelled payment has to
  // return there too. Sending an app buyer to /pricing lands them on a
  // protected web page with no browser session — the app authenticates with
  // a bearer token, not cookies — so it bounces to /sign-in, and cancelling
  // a payment looks like being signed out of an app you are still signed
  // into. Success already returned to the app; this is the other half.
  //
  // Only a still-pending checkout is failed here. eSPees has been seen
  // calling the fail URL half a second after the return URL for the same
  // checkout (production, 2026-09-30); marking a paid checkout failed
  // would be wrong, and a repeat hit must change nothing.
  let returnTo: string | undefined;
  if (nonce) {
    try {
      const record = await readPendingPayment(nonce);
      returnTo = record?.returnTo;
      if (record) {
        extra = { status: record.status, plan: record.plan, app: isAppCallback(record.returnTo), ageS: Math.round((Date.now() - record.createdAt) / 1000) };
        outcome = record.status === "pending" ? "failed" : "ignored_not_pending";
      }
      if (record?.status === "pending") {
        await recordFailedCheckout(record, { country: req.headers.get("x-vercel-ip-country") });
        await updatePaymentStatus(nonce, "failed");
      }
    } catch (e) {
      // Non-fatal: fall through to the web redirect.
      outcome = "error";
      extra = { ...extra, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
    }
  }
  traceEspees("fail", outcome, url, shape, extra);

  if (isAppCallback(returnTo)) {
    return redirectToApp({ payment: "cancelled" });
  }

  return NextResponse.redirect(origin + "/pricing?error=payment_failed", { status: 303 });
}

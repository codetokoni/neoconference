// src/app/api/billing/espees/fail/route.ts
//
// GET /api/billing/espees/fail?nonce=<hex>
//
// eSPees redirects the user here when a payment is cancelled or fails.
// We mark the pending KV record as failed and bounce back to /pricing.

import { NextResponse } from "next/server";
import { readPendingPayment, updatePaymentStatus } from "@/lib/billingStore";
import { isAppCallback, redirectToApp } from "@/lib/app-callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nonce = (url.searchParams.get("nonce") || "").trim();
  const origin = url.origin;

  // Read before marking it failed: the record is where we learn whether
  // this purchase started in the mobile app, and a cancelled payment has to
  // return there too. Sending an app buyer to /pricing lands them on a
  // protected web page with no browser session — the app authenticates with
  // a bearer token, not cookies — so it bounces to /sign-in, and cancelling
  // a payment looks like being signed out of an app you are still signed
  // into. Success already returned to the app; this is the other half.
  let returnTo: string | undefined;
  if (nonce) {
    try {
      const record = await readPendingPayment(nonce);
      returnTo = record?.returnTo;
    } catch {
      // Non-fatal: fall through to the web redirect.
    }
    try {
      await updatePaymentStatus(nonce, "failed");
    } catch {
      // non-fatal
    }
  }

  if (isAppCallback(returnTo)) {
    return redirectToApp({ payment: "cancelled" });
  }

  return NextResponse.redirect(origin + "/pricing?error=payment_failed", { status: 303 });
}

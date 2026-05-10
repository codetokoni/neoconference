// src/app/api/billing/espees/fail/route.ts
//
// GET /api/billing/espees/fail?nonce=<hex>
//
// eSPees redirects the user here when a payment is cancelled or fails.
// We mark the pending KV record as failed and bounce back to /pricing.

import { NextResponse } from "next/server";
import { updatePaymentStatus } from "@/lib/billingStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nonce = (url.searchParams.get("nonce") || "").trim();
  const origin = url.origin;

  if (nonce) {
    try {
      await updatePaymentStatus(nonce, "failed");
    } catch {
      // non-fatal
    }
  }

  return NextResponse.redirect(origin + "/pricing?error=payment_failed", { status: 303 });
}

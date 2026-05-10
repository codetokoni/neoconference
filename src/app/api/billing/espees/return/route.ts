// src/app/api/billing/espees/return/route.ts
//
// GET /api/billing/espees/return?nonce=<hex>
//
// eSPees redirects the user here after a successful payment. We:
//   1. Look up the pending KV record by nonce.
//   2. If pending, mark it paid and write plan to Clerk publicMetadata.
//   3. Redirect the browser to /dashboard?upgraded=<plan>.
//
// Honest gap: without an eSPees server-to-server webhook, we cannot
// independently verify the payment cleared. v1 trusts the redirect; we
// will harden when eSPees publishes a verify endpoint or webhook.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { readPendingPayment, updatePaymentStatus } from "@/lib/billingStore";

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
    return NextResponse.redirect(origin + "/dashboard?upgraded=" + record.plan, { status: 303 });
  }

  if (record.status !== "pending") {
    return NextResponse.redirect(origin + "/pricing?error=already_resolved", { status: 303 });
  }

  // Promote the user. Preserve any existing publicMetadata.
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(record.userId);
    await client.users.updateUserMetadata(record.userId, {
      publicMetadata: { ...(user.publicMetadata ?? {}), plan: record.plan },
    });
  } catch (e) {
    // Mark failed so user can retry; surface error to /pricing.
    await updatePaymentStatus(nonce, "failed");
    const msg = encodeURIComponent("clerk_update_failed");
    return NextResponse.redirect(origin + "/pricing?error=" + msg, { status: 303 });
  }

  await updatePaymentStatus(nonce, "paid");

  return NextResponse.redirect(origin + "/dashboard?upgraded=" + record.plan, { status: 303 });
}

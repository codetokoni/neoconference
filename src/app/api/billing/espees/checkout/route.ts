// src/app/api/billing/espees/checkout/route.ts
//
// POST /api/billing/espees/checkout
// Body: { plan: "pro" | "business" }
// Response on success: 200 { url: string }   (client should window.location to it)
// Response on auth fail: 401 { error: "unauthenticated" }
// Response on validation fail: 400 { error: string }
// Response on eSPees fail: 502 { error: string }

import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { initiatePayment, ESPEES_PRODUCTS, type EspeesPlan } from "@/lib/espees";
import { createPendingPayment, attachPaymentRef, generateNonce } from "@/lib/billingStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isEspeesPlan(p: unknown): p is EspeesPlan {
  return p === "pro" || p === "business";
}

function originFromHeaders(h: Headers): string {
  const proto = h.get("x-forwarded-proto") || "https";
  const host = h.get("x-forwarded-host") || h.get("host") || "neoconference.vercel.app";
  return proto + "://" + host;
}

export async function POST(req: Request): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const plan = (body && typeof body === "object" ? (body as Record<string, unknown>).plan : undefined);
  if (!isEspeesPlan(plan)) {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }

  // Look up display name (best-effort) for user_data.fullname.
  let fullname = "";
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    fullname = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "";
  } catch {
    // non-fatal
  }

  const h = await headers();
  const origin = originFromHeaders(h);
  const nonce = generateNonce();

  // Persist the pending record BEFORE calling eSPees so a network race
  // cannot leave us with a paid record we can't map back to a user.
  await createPendingPayment({ nonce, userId, plan });

  const successUrl = origin + "/api/billing/espees/return?nonce=" + encodeURIComponent(nonce);
  const failUrl = origin + "/api/billing/espees/fail?nonce=" + encodeURIComponent(nonce);

  const result = await initiatePayment({
    plan,
    nonce,
    successUrl,
    failUrl,
    fullname,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error || "espees_failed" }, { status: 502 });
  }

  if (result.paymentRef) {
    await attachPaymentRef(nonce, result.paymentRef);
  }

  // Return the redirect URL; client navigates the browser to it.
  return NextResponse.json({
    url: result.url,
    plan,
    priceEsp: ESPEES_PRODUCTS[plan].priceEsp,
  });
}

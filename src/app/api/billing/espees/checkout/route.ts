// src/app/api/billing/espees/checkout/route.ts
//
// POST /api/billing/espees/checkout
// Body: { plan: <catalog plan id>, billingCycle: "monthly" | "annual",
//         coupon?: string, quote?: true }
// Response on success: 200 { url, plan, billingCycle, amountEspees, listPriceEspees, discountEspees, coupon, offer }
//   (client should window.location to `url`)
//   With quote: true, the same figures and no url — nothing is started.
// Response on auth fail: 401 { error: "unauthenticated" }
// Response on validation fail: 400 { error: string, message? }
// Response on eSPees fail: 502 { error: string }
//
// The price is the plan's current ESP price in the admin plan catalog
// (src/lib/billing), less a coupon or a running offer (src/lib/billing/
// checkout.ts). A plan is sold here only if the catalog marks it for sale —
// by default Starter, Pro and Business; Enterprise routes to email.

import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { initiatePayment, type BillingCycle } from "@/lib/espees";
import { createPendingPayment, attachPaymentRef, generateNonce } from "@/lib/billingStore";
import { APP_LINK, isAppCallback } from "@/lib/app-callback";
import { gatewayEnabled } from "@/lib/finance/settings";
import { quoteCheckout } from "@/lib/billing/checkout";
import { isOwnerEmailList } from "@/lib/admin/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isBillingCycle(c: unknown): c is BillingCycle {
    return c === "monthly" || c === "annual";
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
  // An administrator can switch plan payments off in Billing settings.
  if (!(await gatewayEnabled("espees"))) {
    return NextResponse.json({ error: "payments_paused", message: "Plan payments are paused at the moment. Try again later." }, { status: 503 });
  }

  let body: unknown;
    try {
          body = await req.json();
    } catch {
          return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const planId = typeof b.plan === "string" ? b.plan.trim() : "";
    if (!planId) {
          return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
    }

  const cycle = b.billingCycle;
    if (!isBillingCycle(cycle)) {
          return NextResponse.json({ error: "invalid_billing_cycle" }, { status: 400 });
    }

  // Look up display name (best-effort) for user_data.fullname. The owner is
  // enterprise by identity; a purchase would only write a plan nothing reads.
  let fullname = "";
    try {
          const client = await clerkClient();
          const user = await client.users.getUser(userId);
          if (isOwnerEmailList(user.emailAddresses)) {
                  return NextResponse.json(
                    { error: "owner_protected", message: "The platform owner's account is always Enterprise; there is nothing to buy." },
                    { status: 403 },
                  );
          }
          fullname = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "";
    } catch {
          // non-fatal
    }

  const quote = await quoteCheckout({ planId, cycle, couponCode: typeof b.coupon === "string" ? b.coupon : null, userId });
  if (!quote.ok) {
        return NextResponse.json({ error: quote.error, message: quote.message }, { status: quote.status });
  }
  const figures = {
        plan: quote.plan.id,
        planName: quote.plan.current.name,
        billingCycle: cycle,
        amountEspees: quote.amountEsp,
        listPriceEspees: quote.listPriceEsp,
        discountEspees: quote.discountEsp,
        coupon: quote.coupon?.code ?? null,
        offer: quote.offer ? { id: quote.offer.id, label: quote.offer.label } : null,
  };
  if (b.quote === true) return NextResponse.json({ ok: true, ...figures });

  // The request's own headers (what next/headers would return here).
  const origin = originFromHeaders(req.headers);
    const nonce = generateNonce();

  // Persist the pending record BEFORE calling eSPees so a network race
  // cannot leave us with a paid record we can't map back to a user.
  // Only the app's one App Link is accepted as a return destination, using
  // the same whole-string comparison as the sign-in callbacks. A free-form
  // returnTo here would be an open redirect that fires after a payment.
  const returnTo = isAppCallback(b.returnTo as string | undefined) ? APP_LINK : undefined;

  await createPendingPayment({
        nonce,
        userId,
        plan: quote.plan.baseTier,
        billingCycle: cycle,
        returnTo,
        planId: quote.plan.id,
        planVersion: quote.plan.current.version,
        amountEsp: quote.amountEsp,
        listPriceEsp: quote.listPriceEsp,
        couponCode: quote.coupon?.code ?? null,
        offerId: quote.offer?.id ?? null,
  });

  const successUrl = origin + "/api/billing/espees/return?nonce=" + encodeURIComponent(nonce);
    const failUrl = origin + "/api/billing/espees/fail?nonce=" + encodeURIComponent(nonce);

  const result = await initiatePayment({
        plan: quote.plan.id,
        planName: quote.plan.current.name,
        amountEsp: quote.amountEsp,
        billingCycle: cycle,
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
  return NextResponse.json({ url: result.url, ...figures });
}

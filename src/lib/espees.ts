// src/lib/espees.ts
//
// eSPees v2 product-checkout integration. Initiates a payment by POSTing
// to https://api.espees.org/v2/payment/product. The merchant_wallet field
// in the body authenticates the request (no Authorization header needed).
//
// Response shape: { statusCode, message, payment_ref, url }
// We redirect the user to `url`; eSPees redirects back to success_url or
// fail_url after the user completes (or cancels) the payment.
//
// Pricing for v1 is monthly only:
//   Starter  = SKU "neo_starter_monthly", 10 ESP
//   Pro      = SKU "neo_pro_monthly",     20 ESP
//   Business = SKU "neo_biz_monthly",     30 ESP
//
// Note: the "enterprise" plan is intentionally absent here — it has no
// self-serve checkout. The pricing page routes Enterprise CTAs to
// mailto:info@neoconference.app instead.

const ENDPOINT = "https://api.espees.org/v2/payment/product";

export type EspeesPlan = "starter" | "pro" | "business";

export type EspeesProduct = {
    sku: string;
    priceEsp: number;
    narration: string;
};

export const ESPEES_PRODUCTS: Record<EspeesPlan, EspeesProduct> = {
    starter: {
          sku: "neo_starter_monthly",
          priceEsp: 10,
          narration: "NeoConference Starter - Monthly subscription",
    },
    pro: {
          sku: "neo_pro_monthly",
          priceEsp: 20,
          narration: "NeoConference Pro - Monthly subscription",
    },
    business: {
          sku: "neo_biz_monthly",
          priceEsp: 30,
          narration: "NeoConference Business - Monthly subscription",
    },
};

export type InitiateInput = {
    plan: EspeesPlan;
    nonce: string;
    successUrl: string;
    failUrl: string;
    fullname?: string;
};

export type InitiateResult =
    | { ok: true; url: string; paymentRef: string }
  | { ok: false; error: string };

/**
 * Initiate an eSPees payment. Returns the redirect URL on success.
 * Throws only on network errors; logical failures come back as { ok: false }.
 */
export async function initiatePayment(input: InitiateInput): Promise<InitiateResult> {
    const wallet = (process.env.ESPEES_MERCHANT_WALLET || "").trim();
    if (!wallet) return { ok: false, error: "ESPEES_MERCHANT_WALLET not configured" };

  const apiKey = process.env.ESPEES_API_KEY;
    if (!apiKey) return { ok: false, error: "ESPEES_API_KEY not configured" };

  const product = ESPEES_PRODUCTS[input.plan];
    if (!product) return { ok: false, error: "Unknown plan: " + input.plan };

  const skuEnvVar =
        input.plan === "starter"
        ? "ESPEES_STARTER_SKU"
          : input.plan === "pro"
          ? "ESPEES_PRO_SKU"
            : "ESPEES_BUSINESS_SKU";
    const sku = process.env[skuEnvVar];
    if (!sku) return { ok: false, error: skuEnvVar + " not configured" };

  const body = {
        product_sku: sku,
        narration: product.narration,
        price: product.priceEsp,
        merchant_wallet: wallet,
        success_url: input.successUrl,
        fail_url: input.failUrl,
        user_data: {
                nonce: input.nonce,
                plan: input.plan,
                fullname: input.fullname || "",
        },
  };

  let res: Response;
    try {
          res = await fetch(ENDPOINT, {
                  method: "POST",
                  headers: {
                            "Content-Type": "application/json",
                            "x-api-key": apiKey,
                  },
                  body: JSON.stringify(body),
                  cache: "no-store",
          });
    } catch (e) {
          return { ok: false, error: "Network error contacting eSPees: " + (e as Error).message };
    }

  let json: unknown;
    try {
          json = await res.json();
    } catch {
          return { ok: false, error: "eSPees returned non-JSON response (status " + res.status + ")" };
    }

  const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
    const paymentRef = typeof obj.payment_ref === "string" ? obj.payment_ref : "";
    const url = paymentRef ? `https://payment.espees.org/pay/${paymentRef}` : (typeof obj.url === "string" ? obj.url : "");
    const message = typeof obj.message === "string" ? obj.message : "Unknown eSPees error";

  if (!res.ok || !url) {
        return { ok: false, error: message };
  }

  return { ok: true, url, paymentRef };
}

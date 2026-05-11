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
//   Pro      = SKU "neo_pro_monthly", 20 ESP / ~N9,000
//   Business = SKU "neo_biz_monthly", 30 ESP / ~N19,000

const ENDPOINT = "https://api.espees.org/v2/payment/product";

export type EspeesPlan = "pro" | "business";

export type EspeesProduct = {
  sku: string;
  priceEsp: number;
  priceNgn: number;
  narration: string;
};

export const ESPEES_PRODUCTS: Record<EspeesPlan, EspeesProduct> = {
  pro: {
    sku: "neo_pro_monthly",
    priceEsp: 20,
    priceNgn: 9000,
    narration: "NeoConference Pro - Monthly subscription",
  },
  business: {
    sku: "neo_biz_monthly",
    priceEsp: 30,
    priceNgn: 19000,
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

  const body = {
    product_sku: product.sku,
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

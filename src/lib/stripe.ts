// src/lib/stripe.ts
//
// Tiny Stripe REST client. Avoids the official SDK dependency so we can stay
// web-editor friendly. Implements only the two endpoints we need:
//   - POST /v1/checkout/sessions       (create a Checkout Session)
//   - GET /v1/checkout/sessions/:id    (retrieve - used by webhook fallback)
//
// Webhook signature verification uses Web Crypto so it works on Edge.
//
// Required env:
//   STRIPE_SECRET_KEY      sk_test_... or sk_live_...
//   STRIPE_WEBHOOK_SECRET  whsec_... (from your endpoint)
//   NEXT_PUBLIC_APP_URL    https://neoconference.vercel.app  (for return_url)

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://neoconference.vercel.app';
}

function encodeForm(data: Record<string, string | number | boolean | undefined | null>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    out.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}

export type CheckoutInput = {
  eventId: string;
  eventSlug: string;
  eventName: string;
  tierId: string;
  tierLabel: string;
  priceCents: number;
  currency: string;
  customerEmail?: string;
  buyerUserId?: string;
};

export type CheckoutResult = {
  id: string;
  url: string;
};

export async function createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');

  const successUrl = appUrl() + '/e/' + encodeURIComponent(input.eventSlug) + '?ticket=success&session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl = appUrl() + '/e/' + encodeURIComponent(input.eventSlug) + '?ticket=cancel';

  const body = encodeForm({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': input.currency,
    'line_items[0][price_data][unit_amount]': input.priceCents,
    'line_items[0][price_data][product_data][name]': input.eventName + ' · ' + input.tierLabel,
    customer_email: input.customerEmail,
    'metadata[eventId]': input.eventId,
    'metadata[eventSlug]': input.eventSlug,
    'metadata[tierId]': input.tierId,
    'metadata[buyerUserId]': input.buyerUserId,
    'payment_intent_data[metadata][eventId]': input.eventId,
    'payment_intent_data[metadata][tierId]': input.tierId,
  });

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Stripe ' + res.status + ': ' + text.slice(0, 300));
  }
  const data = (await res.json()) as { id?: string; url?: string };
  if (!data.id || !data.url) throw new Error('Stripe returned malformed session');
  return { id: data.id, url: data.url };
}

export async function retrieveCheckoutSession(id: string): Promise<unknown> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + key },
  });
  if (!res.ok) throw new Error('Stripe retrieve ' + res.status);
  return res.json();
}

// --- Webhook signature verification (Edge-compatible) ---
// Stripe-Signature header looks like: t=<ts>,v1=<sig>,v0=<sig>
// We verify HMAC-SHA256 over the payload `${t}.${rawBody}` matches v1.

function parseSigHeader(header: string): { t: string; v1: string[] } | null {
  const out: { t: string; v1: string[] } = { t: '', v1: [] };
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=');
    if (k === 't') out.t = v;
    if (k === 'v1') out.v1.push(v);
  }
  return out.t && out.v1.length > 0 ? out : null;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyWebhook(rawBody: string, sigHeader: string | null, tolerance = 300): Promise<unknown | null> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return null;
  const parsed = parseSigHeader(sigHeader);
  if (!parsed) return null;
  const ts = parseInt(parsed.t, 10);
  if (!Number.isFinite(ts)) return null;
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (ageSec > tolerance) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(parsed.t + '.' + rawBody));
  const expected = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const ok = parsed.v1.some((sig) => timingSafeEqualHex(sig, expected));
  if (!ok) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}


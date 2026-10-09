// src/lib/finance/paymentIndex.ts
//
// The one place every payment is listed, whatever took it:
//
//   billing:index   zset  member -> time (unix ms)
//     "pay:<paymentRef>"   a plan payment in paymentsStore (eSPees or manual)
//     "tkt:<sessionId>"    a ticket bought through Stripe Checkout (ledger.ts)
//
// Before this, payments were only reachable per user (billing:payments:<uid>),
// so nothing could list them all. recordPayment() and the Stripe webhook add
// to it as they write; POST /api/admin/billing/backfill fills it from what
// was there before. Kept apart from ledger.ts so paymentsStore can call it
// without importing the ledger (which imports paymentsStore).

import { kv } from "@/lib/kv";

export const PAYMENT_INDEX = "billing:index";

export const payId = (paymentRef: string) => `pay:${paymentRef}`;
export const ticketId = (sessionId: string) => `tkt:${sessionId}`;

function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

/**
 * Add (or move) one payment in the index. Never throws: a payment that
 * reached its own record must not fail because the index write did; the
 * backfill puts it back. No-op without KV (paymentsStore then keeps
 * payments in memory, and so does nothing that could be listed).
 */
export async function indexPayment(id: string, at: number): Promise<void> {
  if (!kvConfigured()) return;
  try {
    await kv.zadd(PAYMENT_INDEX, { score: at, member: id });
  } catch (err) {
    console.error("[billing-index] write failed", id, err);
  }
}

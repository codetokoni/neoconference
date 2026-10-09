// src/lib/ops/queues.ts
//
// What is waiting or stuck outside the job runner, read-only:
//   - pending eSPees checkouts (billing:pending:<nonce>, 1-hour TTL);
//   - LiveKit webhook events that arrived and changed nothing;
//   - payment failures in the last 24 hours (failed checkouts and payment
//     records marked failed), which the alerts also count.
// Transcription jobs are in src/lib/ops/media.ts.

import { kv } from "@/lib/kv";
import type { PendingPayment } from "@/lib/billingStore";
import type { PaymentRecord } from "@/lib/paymentsStore";
import { readWebhookRejections } from "@/lib/webhookMetrics";
import { parseJson, scanKeys } from "@/lib/ops/util";

export async function pendingCheckouts(cap = 500) {
  const { keys, truncated } = await scanKeys("billing:pending:*", cap);
  const rows = (await Promise.all(keys.map(async (k) => parseJson<PendingPayment>(await kv.get(k))))).filter((p): p is PendingPayment => !!p);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return {
    total: rows.length,
    byStatus: rows.reduce<Record<string, number>>((m, p) => ((m[p.status] = (m[p.status] ?? 0) + 1), m), {}),
    // The nonce is the checkout's only secret; show a prefix.
    items: rows.slice(0, 50).map((p) => ({ nonce: p.nonce.slice(0, 8) + "…", userId: p.userId, plan: p.plan, billingCycle: p.billingCycle, status: p.status, createdAt: p.createdAt })),
    truncated,
  };
}

export async function paymentFailures(windowMs = 24 * 60 * 60 * 1000, now = Date.now(), cap = 3000) {
  const since = now - windowMs;
  const out: Array<{ at: number; source: "checkout" | "payment"; ref: string; userId: string; plan: string }> = [];
  const pending = await scanKeys("billing:pending:*", cap);
  for (const k of pending.keys) {
    const p = parseJson<PendingPayment>(await kv.get(k));
    if (p?.status === "failed" && p.createdAt >= since) out.push({ at: p.createdAt, source: "checkout", ref: p.nonce.slice(0, 8) + "…", userId: p.userId, plan: p.plan });
  }
  const payments = await scanKeys("billing:payment:*", cap);
  for (const k of payments.keys) {
    const p = parseJson<PaymentRecord>(await kv.get(k));
    if (p?.status === "failed" && p.paidAt >= since) out.push({ at: p.paidAt, source: "payment", ref: p.paymentRef, userId: p.userId, plan: p.plan });
  }
  out.sort((a, b) => b.at - a.at);
  return { count: out.length, items: out.slice(0, 50), truncated: pending.truncated || payments.truncated };
}

export async function webhookRejections() {
  return readWebhookRejections(50);
}

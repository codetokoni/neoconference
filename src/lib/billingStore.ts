// src/lib/billingStore.ts
//
// KV-backed store for pending eSPees payments. Each checkout creates a
// nonce-keyed record; the success/fail handlers look it up by nonce to
// confirm and upgrade the user.
//
// TTL: 1 hour. If the user does not finish paying within an hour, the
// record expires and they need to start over.

import { kv } from "@vercel/kv";
import type { EspeesPlan, BillingCycle } from "./espees";

const KEY_PREFIX = "billing:pending:";
const TTL_SECONDS = 60 * 60; // 1 hour

export type PendingPaymentStatus = "pending" | "paid" | "failed";

export type PendingPayment = {
  nonce: string;
  userId: string;
  plan: EspeesPlan;
  billingCycle: BillingCycle;
  status: PendingPaymentStatus;
  paymentRef: string;
  createdAt: number;
};

function key(nonce: string): string {
  return KEY_PREFIX + nonce;
}

/**
 * Generate a cryptographically random nonce. Uses Web Crypto so it works
 * in both edge and node runtimes.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

export async function createPendingPayment(input: {
  nonce: string;
  userId: string;
  plan: EspeesPlan;
  billingCycle: BillingCycle;
  paymentRef?: string;
}): Promise<void> {
  const record: PendingPayment = {
    nonce: input.nonce,
    userId: input.userId,
    plan: input.plan,
    billingCycle: input.billingCycle,
    status: "pending",
    paymentRef: input.paymentRef || "",
    createdAt: Date.now(),
  };
  await kv.set(key(input.nonce), record, { ex: TTL_SECONDS });
}

export async function readPendingPayment(nonce: string): Promise<PendingPayment | null> {
  if (!nonce) return null;
  const v = await kv.get<PendingPayment>(key(nonce));
  return v || null;
}

export async function updatePaymentStatus(nonce: string, status: PendingPaymentStatus): Promise<PendingPayment | null> {
  const existing = await readPendingPayment(nonce);
  if (!existing) return null;
  const updated: PendingPayment = { ...existing, status };
  // Keep the record around briefly after resolution so re-hits return a
  // sane response, but expire faster than the original window.
  await kv.set(key(nonce), updated, { ex: 5 * 60 });
  return updated;
}

export async function attachPaymentRef(nonce: string, paymentRef: string): Promise<void> {
  const existing = await readPendingPayment(nonce);
  if (!existing) return;
  const updated: PendingPayment = { ...existing, paymentRef };
  await kv.set(key(nonce), updated, { ex: TTL_SECONDS });
}

// src/lib/finance/checkouts.ts
//
// A lasting record of every eSPees checkout that was started. The pending
// record in billingStore expires an hour after checkout, so on its own
// nothing remembers a checkout nobody finished; this does, for the
// outstanding-payments figures and the abandoned-checkout reminder.
//
//   billing:checkout:<nonce>   CheckoutLog (kept 400 days)
//   billing:checkouts          zset nonce -> started (unix ms)
//
// billingStore calls trackCheckout() when it creates a pending record and
// trackCheckoutStatus() when it resolves one. Neither throws: a checkout
// must never fail because its log line could not be written.
//
// Status: "pending" until the return route marks it paid or the fail
// route marks it failed. A "pending" checkout older than the pending
// record's hour was abandoned — the buyer never came back.

import { kv } from "@/lib/kv";

const KEY = (nonce: string) => `billing:checkout:${nonce}`;
const INDEX = "billing:checkouts";
const KEEP_S = 400 * 24 * 60 * 60;
/** billingStore's pending TTL: after this a pending checkout cannot complete. */
export const CHECKOUT_WINDOW_MS = 60 * 60 * 1000;

export type CheckoutStatus = "pending" | "paid" | "failed";

export interface CheckoutLog {
  nonce: string;
  userId: string;
  plan: string;
  planId?: string;
  billingCycle: string;
  /** What checkout asked eSPees to charge, when known. */
  amount: number | null;
  currency: "ESP";
  status: CheckoutStatus;
  createdAt: number;
  resolvedAt?: number;
  paymentRef?: string;
}

function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

/** The amount a pending record carries, else the tier's built-in price. */
function amountOf(p: Record<string, unknown>): number | null {
  if (typeof p.amountEsp === "number") return p.amountEsp;
  return null;
}

export async function trackCheckout(p: {
  nonce: string;
  userId: string;
  plan: string;
  billingCycle: string;
  createdAt: number;
  paymentRef?: string;
  [k: string]: unknown;
}): Promise<void> {
  if (!kvConfigured()) return;
  try {
    const log: CheckoutLog = {
      nonce: p.nonce,
      userId: p.userId,
      plan: p.plan,
      ...(typeof p.planId === "string" ? { planId: p.planId } : {}),
      billingCycle: p.billingCycle,
      amount: amountOf(p) ?? (await builtInPrice(p.plan, p.billingCycle)),
      currency: "ESP",
      status: "pending",
      createdAt: p.createdAt,
      ...(p.paymentRef ? { paymentRef: p.paymentRef } : {}),
    };
    await kv.set(KEY(p.nonce), log, { ex: KEEP_S });
    await kv.zadd(INDEX, { score: p.createdAt, member: p.nonce });
  } catch (err) {
    console.error("[billing-checkouts] track failed", err);
  }
}

async function builtInPrice(plan: string, cycle: string): Promise<number | null> {
  const { ESPEES_AMOUNTS } = await import("@/lib/espees");
  return (ESPEES_AMOUNTS as Record<string, Record<string, number> | undefined>)[plan]?.[cycle] ?? null;
}

export async function trackCheckoutStatus(nonce: string, status: CheckoutStatus, paymentRef?: string): Promise<void> {
  if (!kvConfigured() || !nonce) return;
  try {
    const log = await readCheckout(nonce);
    if (!log) return;
    const next: CheckoutLog = {
      ...log,
      status,
      ...(status !== "pending" ? { resolvedAt: log.resolvedAt ?? Date.now() } : {}),
      ...(paymentRef ? { paymentRef } : {}),
    };
    await kv.set(KEY(nonce), next, { ex: KEEP_S });
  } catch (err) {
    console.error("[billing-checkouts] status failed", err);
  }
}

export async function readCheckout(nonce: string): Promise<CheckoutLog | null> {
  const v = await kv.get<CheckoutLog>(KEY(nonce));
  return v ?? null;
}

/** Checkouts started between from and to (inclusive), oldest first. */
export async function listCheckouts(from: number, to: number): Promise<CheckoutLog[]> {
  const nonces = ((await kv.zrange(INDEX, from, to, { byScore: true })) ?? []) as string[];
  const logs = await Promise.all(nonces.map((n) => readCheckout(String(n))));
  return logs.filter((l): l is CheckoutLog => !!l);
}

export type CheckoutState = "in_progress" | "abandoned" | "paid" | "failed";

/** Where a checkout stands now: a pending one past its hour was abandoned. */
export function checkoutState(log: CheckoutLog, now: number): CheckoutState {
  if (log.status === "paid") return "paid";
  if (log.status === "failed") return "failed";
  return now - log.createdAt > CHECKOUT_WINDOW_MS ? "abandoned" : "in_progress";
}

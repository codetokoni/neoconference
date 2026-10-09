// src/lib/finance/ledger.ts
//
// Every payment the platform has taken, in one shape, for the admin billing
// area. Two stores feed it:
//
//   - plan payments: paymentsStore (billing:payment:<ref>), from the eSPees
//     return route, the eSPees fail route (status "failed") and manual grants;
//   - ticket sales: billing:ticket:<sessionId>, written here by the Stripe
//     webhook. Stripe hosts the card form; no card detail ever reaches us —
//     a ticket record holds the Checkout Session and PaymentIntent ids, the
//     amount, the currency and the buyer's email, and nothing else.
//
// Both are listed in billing:index (paymentIndex.ts). Amounts carry their
// currency: plan payments are in ESP; tickets in whatever the tier was
// priced in. Nothing here adds amounts of different currencies together.

import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import { readPayment, type PaymentRecord } from "@/lib/paymentsStore";
import { PAYMENT_INDEX, indexPayment, payId, ticketId } from "@/lib/finance/paymentIndex";
import { addTo, fromMinor, normCurrency, round, type ByCurrency } from "@/lib/finance/money";

export const TICKET_KEY = (sessionId: string) => `billing:ticket:${sessionId}`;
/** Payment-intent id -> session id, so a refund made in Stripe finds its sale. */
const TICKET_BY_PI = (pi: string) => `billing:ticket:pi:${pi}`;

export type Provider = "espees" | "stripe" | "manual";
export type EntryStatus = "paid" | "partially_refunded" | "refunded" | "failed";

export interface RefundEntry {
  id: string;
  amount: number;
  currency: string;
  at: number;
  /** "stripe": sent back through the Stripe API. "outside": money returned
   *  outside NeoConference (eSPees has no refund API) and recorded here. */
  method: "stripe" | "outside";
  /** Stripe refund id, or the reference the admin typed for an outside refund. */
  providerRef?: string;
  /** Stripe's own status for an API refund ("succeeded", "pending", …). */
  providerStatus?: string;
  reason?: string;
  byEmail: string;
  byUserId: string;
  downgraded?: boolean;
}

/** What the finance code adds to a paymentsStore record. */
export interface PaymentExtras {
  refunds?: RefundEntry[];
  refundedAmount?: number;
  failureReason?: string;
  /** ISO country of the buyer when known (for tax on the invoice). */
  country?: string;
}

export type PlanPayment = PaymentRecord & PaymentExtras;

export interface TicketPayment {
  sessionId: string;
  paymentIntent: string | null;
  userId: string | null;
  email: string | null;
  name: string | null;
  eventId: string;
  eventSlug?: string;
  eventName?: string;
  tierId?: string;
  tierLabel?: string;
  /** Minor units, as Stripe reports them. */
  amountMinor: number;
  currency: string;
  status: "paid" | "failed";
  at: number;
  country?: string;
  failureReason?: string;
  invoiceNumber?: string;
  refunds?: RefundEntry[];
  refundedAmount?: number;
}

export interface LedgerEntry {
  id: string;
  provider: Provider;
  kind: "plan" | "ticket";
  ref: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  description: string;
  plan?: string;
  planId?: string;
  cycle?: string;
  amount: number;
  currency: string;
  status: EntryStatus;
  at: number;
  periodStart?: number;
  periodEnd?: number;
  /** eSPees grants are trusted from the browser redirect: never verified with eSPees. */
  verified: boolean;
  source: string;
  invoiceNumber?: string;
  refundedAmount: number;
  refunds: RefundEntry[];
  failureReason?: string;
  country?: string;
  eventId?: string;
}

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
};

function statusOf(base: "paid" | "failed" | "refunded", amount: number, refunded: number): EntryStatus {
  if (base === "failed") return "failed";
  if (base === "refunded") return "refunded";
  if (refunded > 0 && refunded + 1e-9 >= amount) return "refunded";
  if (refunded > 0) return "partially_refunded";
  return "paid";
}

export function planEntry(r: PlanPayment): LedgerEntry {
  const refunds = r.refunds ?? [];
  const refunded = round(r.refundedAmount ?? refunds.reduce((s, x) => s + x.amount, 0));
  const provider: Provider = r.source === "manual" ? "manual" : "espees";
  const planLabel = PLAN_NAMES[r.plan] ?? r.plan;
  return {
    id: payId(r.paymentRef),
    provider,
    kind: "plan",
    ref: r.paymentRef,
    userId: r.userId,
    email: null,
    name: null,
    description: `${planLabel} plan, ${r.billingCycle === "annual" ? "annual" : "monthly"}`,
    plan: r.plan,
    planId: (r as { planId?: string }).planId,
    cycle: r.billingCycle,
    amount: r.amountEsp,
    currency: "ESP",
    status: statusOf(r.status, r.amountEsp, refunded),
    at: r.paidAt,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    verified: r.source === "espees-verified" || r.source === "manual",
    source: r.source,
    invoiceNumber: r.invoiceNumber,
    refundedAmount: refunded,
    refunds,
    failureReason: r.failureReason,
    country: r.country,
  };
}

export function ticketEntry(t: TicketPayment): LedgerEntry {
  const currency = normCurrency(t.currency);
  const amount = fromMinor(t.amountMinor, currency);
  const refunds = t.refunds ?? [];
  const refunded = round(t.refundedAmount ?? refunds.reduce((s, x) => s + x.amount, 0), currency);
  return {
    id: ticketId(t.sessionId),
    provider: "stripe",
    kind: "ticket",
    ref: t.sessionId,
    userId: t.userId,
    email: t.email,
    name: t.name,
    description: `Ticket: ${t.eventName ?? t.eventSlug ?? t.eventId}${t.tierLabel ? ` · ${t.tierLabel}` : ""}`,
    amount,
    currency,
    status: statusOf(t.status, amount, refunded),
    at: t.at,
    verified: true,
    source: "stripe-webhook",
    invoiceNumber: t.invoiceNumber,
    refundedAmount: refunded,
    refunds,
    failureReason: t.failureReason,
    country: t.country,
    eventId: t.eventId,
  };
}

/* ------------------------------ reads ------------------------------ */

export async function readTicket(sessionId: string): Promise<TicketPayment | null> {
  return ((await kv.get<TicketPayment>(TICKET_KEY(sessionId))) ?? null) as TicketPayment | null;
}

export async function saveTicket(t: TicketPayment): Promise<void> {
  await kv.set(TICKET_KEY(t.sessionId), t);
  if (t.paymentIntent) await kv.set(TICKET_BY_PI(t.paymentIntent), t.sessionId);
}

/** One payment by its ledger id ("pay:<ref>" or "tkt:<sessionId>"). */
export async function readEntry(id: string): Promise<LedgerEntry | null> {
  if (id.startsWith("pay:")) {
    const r = (await readPayment(id.slice(4))) as PlanPayment | null;
    return r ? planEntry(r) : null;
  }
  if (id.startsWith("tkt:")) {
    const t = await readTicket(id.slice(4));
    return t ? ticketEntry(t) : null;
  }
  return null;
}

/** Every indexed payment between from and to (unix ms, inclusive), newest first. */
export async function entriesBetween(from = 0, to = Number.MAX_SAFE_INTEGER): Promise<LedgerEntry[]> {
  const ids = ((await kv.zrange(PAYMENT_INDEX, from, to, { byScore: true })) ?? []) as string[];
  const entries = await Promise.all(ids.map((id) => readEntry(String(id))));
  return entries.filter((e): e is LedgerEntry => !!e).sort((a, b) => b.at - a.at);
}

export async function indexSize(): Promise<number> {
  return Number((await kv.zcard(PAYMENT_INDEX)) ?? 0);
}

/* ------------------------- who paid (Clerk) ------------------------- */

type Who = { email: string | null; name: string | null; plan: string | null; planExpiresAt: number | null; exists: boolean };
const whoCache = new Map<string, { at: number; who: Who }>();
const WHO_TTL = 5 * 60 * 1000;

export async function lookupUser(userId: string): Promise<Who> {
  const hit = whoCache.get(userId);
  if (hit && Date.now() - hit.at < WHO_TTL) return hit.who;
  let who: Who = { email: null, name: null, plan: null, planExpiresAt: null, exists: false };
  try {
    const client = await clerkClient();
    const u = (await client.users.getUser(userId)) as unknown as {
      firstName?: string | null;
      lastName?: string | null;
      username?: string | null;
      primaryEmailAddress?: { emailAddress?: string } | null;
      emailAddresses?: { emailAddress: string }[];
      publicMetadata?: Record<string, unknown>;
    };
    const email = (u.primaryEmailAddress?.emailAddress ?? u.emailAddresses?.[0]?.emailAddress ?? "").toLowerCase() || null;
    const md = u.publicMetadata ?? {};
    who = {
      email,
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || null,
      plan: typeof md.plan === "string" ? md.plan : null,
      planExpiresAt: typeof md.planExpiresAt === "number" ? md.planExpiresAt : null,
      exists: true,
    };
  } catch {
    // Deleted account, or Clerk unreachable: show the id alone.
  }
  whoCache.set(userId, { at: Date.now(), who });
  return who;
}

export function forgetUser(userId: string): void {
  whoCache.delete(userId);
}

/** Fill in email and name for entries that only carry a user id. */
export async function withPeople(entries: LedgerEntry[]): Promise<LedgerEntry[]> {
  const ids = [...new Set(entries.filter((e) => e.userId && !e.email).map((e) => e.userId as string))];
  const found = new Map<string, Who>();
  // A handful at a time: Clerk rate-limits bursts.
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const res = await Promise.all(chunk.map((id) => lookupUser(id)));
    chunk.forEach((id, j) => found.set(id, res[j]));
  }
  return entries.map((e) => {
    if (!e.userId || e.email) return e;
    const w = found.get(e.userId);
    return w ? { ...e, email: w.email, name: e.name ?? w.name } : e;
  });
}

/* ------------------------------ queries ------------------------------ */

export interface LedgerQuery {
  from?: number;
  to?: number;
  status?: EntryStatus | "refunds";
  provider?: Provider;
  /** Tier ("pro") or catalog plan id. "ticket" for ticket sales. */
  plan?: string;
  /** A user id, or part of an email. */
  user?: string;
  /** Reference, invoice number, email, name or description. */
  q?: string;
  offset?: number;
  limit?: number;
}

export interface LedgerPage {
  items: LedgerEntry[];
  total: number;
  /** Sums over every match (not just this page), per currency. */
  totals: { paid: ByCurrency; refunded: ByCurrency; failed: ByCurrency };
}

export async function queryLedger(q: LedgerQuery): Promise<LedgerPage> {
  const limit = Math.max(1, Math.min(q.limit ?? 50, 500));
  const offset = Math.max(0, q.offset ?? 0);
  let items = await entriesBetween(q.from ?? 0, q.to ?? Number.MAX_SAFE_INTEGER);
  if (q.status === "refunds") items = items.filter((e) => e.refundedAmount > 0);
  else if (q.status) items = items.filter((e) => e.status === q.status);
  if (q.provider) items = items.filter((e) => e.provider === q.provider);
  if (q.plan) items = items.filter((e) => (q.plan === "ticket" ? e.kind === "ticket" : e.plan === q.plan || e.planId === q.plan));
  // Search needs emails, so fill them in before matching on them.
  const needsPeople = !!(q.user || q.q);
  if (needsPeople) items = await withPeople(items);
  if (q.user) {
    const u = q.user.toLowerCase();
    items = items.filter((e) => e.userId === q.user || (e.email ?? "").includes(u));
  }
  if (q.q) {
    const s = q.q.toLowerCase();
    items = items.filter((e) =>
      [e.ref, e.invoiceNumber, e.email, e.name, e.description, e.userId, ...e.refunds.map((r) => r.providerRef)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(s)),
    );
  }
  const totals = { paid: {} as ByCurrency, refunded: {} as ByCurrency, failed: {} as ByCurrency };
  for (const e of items) {
    if (e.status === "failed") addTo(totals.failed, e.currency, e.amount);
    else addTo(totals.paid, e.currency, e.amount);
    if (e.refundedAmount) addTo(totals.refunded, e.currency, e.refundedAmount);
  }
  const page = items.slice(offset, offset + limit);
  return { items: needsPeople ? page : await withPeople(page), total: items.length, totals };
}

/** A user's whole billing history: plan payments and the tickets they bought. */
export async function userEntries(userId: string): Promise<LedgerEntry[]> {
  const all = await entriesBetween();
  return all.filter((e) => e.userId === userId);
}

/* --------------------------- Stripe tickets --------------------------- */

/** The part of a Checkout Session the ledger reads. */
export interface StripeSessionLike {
  id: string;
  payment_status?: string;
  payment_intent?: string | { id?: string } | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null; name?: string | null; address?: { country?: string | null } | null } | null;
  amount_total?: number | null;
  currency?: string | null;
  created?: number;
  metadata?: Record<string, string> | null;
}

function piOf(s: StripeSessionLike): string | null {
  if (!s.payment_intent) return null;
  return typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent.id ?? null;
}

/**
 * Record a ticket sale (or a failed one) from a Checkout Session. Idempotent
 * by session id: Stripe retries webhooks, and the backfill reads the same
 * sessions again. A "paid" write upgrades an earlier "failed" one.
 */
export async function recordTicketSession(
  s: StripeSessionLike,
  status: "paid" | "failed",
  extra: { eventName?: string; tierLabel?: string; failureReason?: string; at?: number } = {},
): Promise<{ created: boolean; record: TicketPayment }> {
  const existing = await readTicket(s.id);
  if (existing && (existing.status === "paid" || existing.status === status)) return { created: false, record: existing };
  const md = s.metadata ?? {};
  const record: TicketPayment = {
    sessionId: s.id,
    paymentIntent: piOf(s),
    userId: md.buyerUserId || null,
    email: (s.customer_email || s.customer_details?.email || "").toLowerCase() || null,
    name: s.customer_details?.name || null,
    eventId: md.eventId || "",
    eventSlug: md.eventSlug,
    eventName: extra.eventName,
    tierId: md.tierId,
    tierLabel: extra.tierLabel,
    amountMinor: Number(s.amount_total ?? 0),
    currency: normCurrency(s.currency),
    status,
    at: extra.at ?? (s.created ? s.created * 1000 : Date.now()),
    ...(s.customer_details?.address?.country ? { country: s.customer_details.address.country } : {}),
    ...(extra.failureReason ? { failureReason: extra.failureReason } : {}),
  };
  await saveTicket(record);
  await indexPayment(ticketId(s.id), record.at);
  return { created: !existing, record };
}

/** A refund made in the Stripe dashboard (charge.refunded), mirrored onto the sale. */
export async function mirrorStripeRefund(charge: {
  payment_intent?: string | null;
  amount_refunded?: number;
  currency?: string;
  refunds?: { data?: { id: string; amount: number; created?: number; status?: string; reason?: string | null }[] };
}): Promise<TicketPayment | null> {
  const pi = charge.payment_intent;
  if (!pi) return null;
  const sid = (await kv.get<string>(TICKET_BY_PI(pi))) as string | null;
  if (!sid) return null;
  const t = await readTicket(sid);
  if (!t) return null;
  const currency = normCurrency(t.currency);
  const known = new Set((t.refunds ?? []).map((r) => r.providerRef));
  const refunds = [...(t.refunds ?? [])];
  for (const r of charge.refunds?.data ?? []) {
    if (known.has(r.id)) continue;
    refunds.push({
      id: `rf_${r.id}`,
      amount: fromMinor(r.amount, currency),
      currency,
      at: r.created ? r.created * 1000 : Date.now(),
      method: "stripe",
      providerRef: r.id,
      providerStatus: r.status,
      reason: r.reason ?? "Refunded in the Stripe dashboard",
      byEmail: "stripe",
      byUserId: "stripe",
    });
  }
  const refundedAmount =
    typeof charge.amount_refunded === "number" ? fromMinor(charge.amount_refunded, currency) : round(refunds.reduce((s, r) => s + r.amount, 0), currency);
  const next = { ...t, refunds, refundedAmount };
  await saveTicket(next);
  return next;
}

/* ------------------------------ backfill ------------------------------ */

export interface BackfillResult {
  planPayments: number;
  ticketSales: number;
  stripe: "imported" | "not_configured" | "failed";
  stripeError?: string;
  indexSize: number;
}

/**
 * Put every payment that existed before the index into it: every
 * billing:payment:<ref> record, every ref in a billing:payments:<uid> list,
 * and — when STRIPE_SECRET_KEY is set — every completed ticket Checkout
 * Session in Stripe (before this, ticket sales were recorded only as a sold
 * count on the event). Safe to run again: it only adds.
 */
export async function backfillIndex(
  listStripeSessions?: () => Promise<StripeSessionLike[]>,
): Promise<BackfillResult> {
  const refs = new Set<string>();
  for (const k of ((await kv.keys("billing:payment:*")) ?? []) as string[]) refs.add(k.slice("billing:payment:".length));
  for (const k of ((await kv.keys("billing:payments:*")) ?? []) as string[]) {
    for (const r of ((await kv.lrange(k, 0, -1)) ?? []) as unknown[]) if (typeof r === "string") refs.add(r);
  }
  let planPayments = 0;
  for (const ref of refs) {
    const r = await readPayment(ref);
    if (!r) continue;
    await kv.zadd(PAYMENT_INDEX, { score: r.paidAt, member: payId(ref) });
    planPayments++;
  }

  let ticketSales = 0;
  let stripe: BackfillResult["stripe"] = "not_configured";
  let stripeError: string | undefined;
  if (listStripeSessions) {
    try {
      for (const s of await listStripeSessions()) {
        if (!s.metadata?.eventId || s.payment_status !== "paid") continue;
        await recordTicketSession(s, "paid");
        ticketSales++;
      }
      stripe = "imported";
    } catch (err) {
      stripe = "failed";
      stripeError = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    }
  }
  return { planPayments, ticketSales, stripe, stripeError, indexSize: await indexSize() };
}

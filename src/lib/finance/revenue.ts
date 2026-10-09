// src/lib/finance/revenue.ts
//
// Revenue figures from the ledger and the checkout log. Pure: give it the
// payments and checkouts, get numbers back. Every money figure is a
// ByCurrency (one total per currency, never summed across them).
//
// Definitions (shown on the Revenue page too):
//   gross        payments taken in the period (failed ones took nothing)
//   refunds      refunds made in the period, by the date of the refund
//   net          gross − refunds, per currency
//   renewal      a plan payment by someone who had paid for a plan before
//   new          a first plan payment
//   cancellation a plan ended by a refund, or a paid period that ran out in
//                the period with no new payment within 3 days of its end
//   MRR          plans active at the end of the period, each counted per
//                month (annual ÷ 12); ARR = MRR × 12
//   outstanding  checkouts started and not finished: still within their hour
//                (in progress) or past it (abandoned)

import { addTo, pctChange, round, type ByCurrency } from "@/lib/finance/money";
import { checkoutState, type CheckoutLog } from "@/lib/finance/checkouts";
import type { LedgerEntry } from "@/lib/finance/ledger";

export const DAY = 24 * 60 * 60 * 1000;
const LAPSE_GRACE = 3 * DAY;

export type Bucket = "day" | "week" | "month";

export function autoBucket(from: number, to: number): Bucket {
  const days = (to - from) / DAY;
  return days <= 45 ? "day" : days <= 200 ? "week" : "month";
}

/** Start of the bucket holding t, in UTC. Weeks start on Monday. */
export function bucketStart(t: number, b: Bucket): number {
  const d = new Date(t);
  if (b === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (b === "day") return day;
  const dow = (d.getUTCDay() + 6) % 7;
  return day - dow * DAY;
}

function nextBucket(t: number, b: Bucket): number {
  if (b === "month") {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return t + (b === "day" ? DAY : 7 * DAY);
}

export function bucketLabel(t: number, b: Bucket): string {
  const iso = new Date(t).toISOString();
  return b === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

export interface PeriodFigures {
  gross: ByCurrency;
  refunds: ByCurrency;
  net: ByCurrency;
  payments: number;
  planPayments: number;
  ticketSales: number;
  newCustomers: number;
  renewals: number;
  /** cancelled: ended by someone (from payments: a refund that ended the plan); lapsed: ran out unrenewed. */
  cancellations: { total: number; cancelled: number; lapsed: number };
  /** Where renewals and cancellations come from. */
  basis: "payments" | "subscriptions";
  failed: { count: number; amount: ByCurrency };
  unverified: number;
}

const inRange = (t: number, from: number, to: number) => t >= from && t <= to;
const taken = (e: LedgerEntry) => e.status !== "failed";

/** Plan payments that took money, per user, oldest first. */
function planHistory(entries: LedgerEntry[]): Map<string, LedgerEntry[]> {
  const m = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (e.kind !== "plan" || !taken(e) || !e.userId) continue;
    const l = m.get(e.userId) ?? [];
    l.push(e);
    m.set(e.userId, l);
  }
  for (const l of m.values()) l.sort((a, b) => a.at - b.at);
  return m;
}

export function periodFigures(entries: LedgerEntry[], from: number, to: number, now: number): PeriodFigures {
  const f: PeriodFigures = {
    gross: {},
    refunds: {},
    net: {},
    payments: 0,
    planPayments: 0,
    ticketSales: 0,
    newCustomers: 0,
    renewals: 0,
    cancellations: { total: 0, cancelled: 0, lapsed: 0 },
    basis: "payments",
    failed: { count: 0, amount: {} },
    unverified: 0,
  };
  for (const e of entries) {
    if (inRange(e.at, from, to)) {
      if (e.status === "failed") {
        f.failed.count++;
        addTo(f.failed.amount, e.currency, e.amount);
      } else {
        f.payments++;
        addTo(f.gross, e.currency, e.amount);
        if (e.kind === "plan") f.planPayments++;
        else f.ticketSales++;
        if (e.kind === "plan" && !e.verified) f.unverified++;
      }
    }
    for (const r of e.refunds) {
      if (!inRange(r.at, from, to)) continue;
      addTo(f.refunds, r.currency, r.amount);
      if (r.downgraded) f.cancellations.cancelled++;
    }
  }
  for (const list of planHistory(entries).values()) {
    list.forEach((e, i) => {
      if (inRange(e.at, from, to)) {
        if (i === 0) f.newCustomers++;
        else f.renewals++;
      }
      // A paid period that ran out with nothing after it.
      if (e.periodEnd && inRange(e.periodEnd, from, to) && e.periodEnd < now - LAPSE_GRACE) {
        const next = list[i + 1];
        const endedByRefund = e.refunds.some((r) => r.downgraded);
        if (!endedByRefund && (!next || next.at > e.periodEnd + LAPSE_GRACE)) f.cancellations.lapsed++;
      }
    });
  }
  f.cancellations.total = f.cancellations.cancelled + f.cancellations.lapsed;
  for (const c of new Set([...Object.keys(f.gross), ...Object.keys(f.refunds)])) {
    f.net[c] = round((f.gross[c] ?? 0) - (f.refunds[c] ?? 0), c);
  }
  return f;
}

export interface Recurring {
  asOf: number;
  mrr: ByCurrency;
  arr: ByCurrency;
  activePaid: number;
  monthly: number;
  annual: number;
  /** Plans the payments say are active but whose account now says otherwise (Clerk). */
  notInClerk: number;
  basis: string;
}

/**
 * MRR from the payments: each user's latest plan payment, if its paid
 * period covers asOf and it was not refunded. With `clerkPlans` (userId ->
 * the plan Clerk holds now), a plan Clerk no longer shows is left out.
 */
export function recurring(entries: LedgerEntry[], asOf: number, clerkPlans?: Map<string, string | null>): Recurring {
  const r: Recurring = { asOf, mrr: {}, arr: {}, activePaid: 0, monthly: 0, annual: 0, notInClerk: 0, basis: "" };
  for (const [userId, list] of planHistory(entries.filter((e) => e.at <= asOf))) {
    const e = list[list.length - 1];
    if (!e.periodStart || !e.periodEnd || !(e.periodStart <= asOf && asOf < e.periodEnd)) continue;
    if (e.status === "refunded" || e.refunds.some((x) => x.downgraded)) continue;
    if (clerkPlans) {
      const p = clerkPlans.get(userId);
      if (!p || p === "free") {
        r.notInClerk++;
        continue;
      }
    }
    const kept = e.amount - e.refundedAmount;
    const perMonth = e.cycle === "annual" ? kept / 12 : kept;
    addTo(r.mrr, e.currency, perMonth);
    r.activePaid++;
    if (e.cycle === "annual") r.annual++;
    else r.monthly++;
  }
  for (const [c, v] of Object.entries(r.mrr)) r.arr[c] = round(v * 12, c);
  r.basis = clerkPlans
    ? "From plan payments, checked against each account's current plan in Clerk."
    : "From plan payments.";
  return r;
}

/** Users whose plan payments say they are active at asOf (for the Clerk check). */
export function activeUserIds(entries: LedgerEntry[], asOf: number): string[] {
  const out: string[] = [];
  for (const [userId, list] of planHistory(entries.filter((e) => e.at <= asOf))) {
    const e = list[list.length - 1];
    if (e.periodStart && e.periodEnd && e.periodStart <= asOf && asOf < e.periodEnd) out.push(userId);
  }
  return out;
}

export interface Outstanding {
  inProgress: { count: number; amount: ByCurrency };
  abandoned: { count: number; amount: ByCurrency };
  failed: { count: number; amount: ByCurrency };
}

export function outstanding(checkouts: CheckoutLog[], entries: LedgerEntry[], from: number, to: number, now: number): Outstanding {
  const o: Outstanding = {
    inProgress: { count: 0, amount: {} },
    abandoned: { count: 0, amount: {} },
    failed: { count: 0, amount: {} },
  };
  for (const c of checkouts) {
    if (!inRange(c.createdAt, from, to)) continue;
    const s = checkoutState(c, now);
    if (s === "in_progress" || s === "abandoned") {
      const slot = s === "in_progress" ? o.inProgress : o.abandoned;
      slot.count++;
      if (c.amount != null) addTo(slot.amount, c.currency, c.amount);
    }
  }
  for (const e of entries) {
    if (e.status !== "failed" || !inRange(e.at, from, to)) continue;
    o.failed.count++;
    addTo(o.failed.amount, e.currency, e.amount);
  }
  return o;
}

export interface SeriesPoint {
  start: number;
  label: string;
  gross: ByCurrency;
  refunds: ByCurrency;
  payments: number;
}

export function series(entries: LedgerEntry[], from: number, to: number, b: Bucket): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  const index = new Map<number, SeriesPoint>();
  for (let t = bucketStart(from, b); t <= to && points.length < 400; t = nextBucket(t, b)) {
    const p = { start: t, label: bucketLabel(t, b), gross: {}, refunds: {}, payments: 0 };
    points.push(p);
    index.set(t, p);
  }
  for (const e of entries) {
    if (taken(e) && inRange(e.at, from, to)) {
      const p = index.get(bucketStart(e.at, b));
      if (p) {
        addTo(p.gross, e.currency, e.amount);
        p.payments++;
      }
    }
    for (const r of e.refunds) {
      if (!inRange(r.at, from, to)) continue;
      const p = index.get(bucketStart(r.at, b));
      if (p) addTo(p.refunds, r.currency, r.amount);
    }
  }
  return points;
}

/** % change per currency between two periods, for gross and net. */
export function comparison(now: PeriodFigures, before: PeriodFigures): Record<string, { gross: number | null; net: number | null }> {
  const out: Record<string, { gross: number | null; net: number | null }> = {};
  for (const c of new Set([...Object.keys(now.gross), ...Object.keys(before.gross), ...Object.keys(now.net), ...Object.keys(before.net)])) {
    out[c] = { gross: pctChange(now.gross[c] ?? 0, before.gross[c] ?? 0), net: pctChange(now.net[c] ?? 0, before.net[c] ?? 0) };
  }
  return out;
}

/* ------------------- from subscription records (phase 3) ------------------- */

/** The fields of a subscription record (src/lib/billing/model.ts) these figures read. */
export interface SubLike {
  userId: string;
  status: string;
  cycle: "monthly" | "annual" | null;
  periodEnd: number | null;
  pricePaid: { amount: number; currency: string } | null;
  endedAt: number | null;
  cancelled?: { atPeriodEnd: boolean } | null;
}

export interface RecurringFromSubs extends Recurring {
  /** Running but paying nothing per period (trial, complimentary, no price recorded). */
  unpaid: number;
  /** Cancelled at period end: paid up, not coming back. */
  ending: number;
}

/**
 * MRR from the subscription records as they stand now: every record giving
 * its plan (not paused, not expired, period not over) with a price for a
 * monthly or annual cycle, counted per month. A record cancelled at period
 * end is still running and counted, and also reported as `ending`.
 */
export function recurringFromSubscriptions(subs: SubLike[], now: number): RecurringFromSubs {
  const r: RecurringFromSubs = { asOf: now, mrr: {}, arr: {}, activePaid: 0, monthly: 0, annual: 0, notInClerk: 0, basis: "", unpaid: 0, ending: 0 };
  for (const s of subs) {
    const running = s.status !== "paused" && s.status !== "expired" && (s.periodEnd == null || s.periodEnd > now);
    if (!running) continue;
    if (s.status === "cancelled" && s.cancelled?.atPeriodEnd) r.ending++;
    if (!s.pricePaid || !(s.pricePaid.amount > 0) || !s.cycle || s.status === "trialing" || s.status === "complimentary") {
      r.unpaid++;
      continue;
    }
    addTo(r.mrr, s.pricePaid.currency, s.cycle === "annual" ? s.pricePaid.amount / 12 : s.pricePaid.amount);
    r.activePaid++;
    if (s.cycle === "annual") r.annual++;
    else r.monthly++;
  }
  for (const [c, v] of Object.entries(r.mrr)) r.arr[c] = round(v * 12, c);
  r.basis = "From the subscription records (Plans & subscriptions).";
  return r;
}

/** Subscriptions that ended in the range, by how: cancelled by someone, or ran out. */
export function endedSubscriptions(subs: SubLike[], from: number, to: number, now: number): { total: number; cancelled: number; lapsed: number } {
  const out = { total: 0, cancelled: 0, lapsed: 0 };
  for (const s of subs) {
    // Ran out but the daily sweep has not marked it expired yet.
    const due = s.endedAt == null && s.status !== "paused" && s.periodEnd != null && s.periodEnd < now;
    const at = s.endedAt ?? (due ? s.periodEnd : null);
    if (at == null || !inRange(at, from, to)) continue;
    out.total++;
    if (s.status === "cancelled") out.cancelled++;
    else out.lapsed++;
  }
  return out;
}

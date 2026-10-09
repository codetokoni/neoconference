// src/lib/billing/subscriptions.ts
//
// A subscription per account, kept in KV next to the Clerk metadata the rest
// of the app enforces from:
//
//   neo:sub:<userId>     Subscription
//   neo:sub:h:<userId>   list of SubHistoryEntry, newest first (capped at 500)
//   neo:subs:users       set of userIds with a record
//   neo:subs:by_end      zset userId -> periodEnd, for every record that has
//                        its plan now and an end date: renewals, expiries,
//                        trial ends and scheduled changes are all due there
//   neo:subs:ended       zset userId -> endedAt, for "recently ended"
//
// Clerk publicMetadata stays the thing enforcement reads (plan.ts):
// syncClerk() writes plan (the base tier), planExpiresAt, planId,
// planVersion and planLimits from the record on every change, and clears
// them back to Free when the record no longer gives a plan. It refuses the
// platform owner — the owner is enterprise by identity (admin/owner.ts),
// never by subscription — and every write goes through it.
//
// eSPees cannot charge a saved wallet or refund, so nothing here moves
// money. See PRORATION_RULE in ./model.ts for how time is converted when a
// plan changes.

import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import { isOwnerEmailList, type ClerkEmailish } from "@/lib/admin/owner";
import { isPlan } from "@/lib/planLimits";
import { listUserPayments } from "@/lib/paymentsStore";
import {
  CYCLE_DAYS,
  DAY_MS,
  convertRemaining,
  dailyPrice,
  effectiveLimits,
  espPrice,
  fmtDays,
  hasAccess,
  isCurrency,
  isCycle,
  mergeLimits,
  summarize,
  type AttachedAddOn,
  type CatalogPlan,
  type CurrencyCode,
  type Cycle,
  type PlanVersion,
  type SubHistoryEntry,
  type Subscription,
} from "@/lib/billing/model";
import { getAddOn, getPlan, getVersion, listCoupons } from "@/lib/billing/store";
import { recordSubscriptionChange } from "@/lib/activityBilling";
import { getTrialPolicy } from "@/lib/platform/settings";

const subKey = (u: string) => `neo:sub:${u}`;
const histKey = (u: string) => `neo:sub:h:${u}`;
const USERS = "neo:subs:users";
const BY_END = "neo:subs:by_end";
const ENDED = "neo:subs:ended";
const MAX_HISTORY = 500;

export type Actor = { userId: string; email: string };
const SYSTEM: Actor = { userId: "system", email: "system (daily job)" };

export class OwnerProtected extends Error {
  constructor() {
    super("The platform owner's account is always Enterprise and has no subscription.");
  }
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

/* ---------------------------------- reads --------------------------------- */

export async function getSubscription(userId: string): Promise<Subscription | null> {
  if (!userId) return null;
  return parse<Subscription>(await kv.get(subKey(userId)));
}

export async function getHistory(userId: string, limit = 100): Promise<SubHistoryEntry[]> {
  const raw = ((await kv.lrange(histKey(userId), 0, limit - 1)) ?? []) as unknown[];
  return raw.map((r) => parse<SubHistoryEntry>(r)).filter((e): e is SubHistoryEntry => !!e);
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const ids = ((await kv.smembers(USERS)) ?? []) as string[];
  const out: Subscription[] = [];
  for (const id of ids) {
    const s = await getSubscription(String(id));
    if (s) out.push(s);
  }
  return out;
}

async function idsByScore(key: string, from: number, to: number, limit = 500): Promise<string[]> {
  const raw = (await kv.zrange(key, from, to, { byScore: true, offset: 0, count: limit })) as unknown[];
  return (raw ?? []).map(String);
}

/** Records whose period (or trial) ends between `from` and `to`, soonest first. */
export async function listByPeriodEnd(from: number, to: number, limit = 500): Promise<Subscription[]> {
  const out: Subscription[] = [];
  for (const id of await idsByScore(BY_END, from, to, limit)) {
    const s = await getSubscription(id);
    if (s) out.push(s);
  }
  return out.sort((a, b) => (a.periodEnd ?? 0) - (b.periodEnd ?? 0));
}

export async function listEnded(from: number, to: number, limit = 500): Promise<Subscription[]> {
  const out: Subscription[] = [];
  for (const id of await idsByScore(ENDED, from, to, limit)) {
    const s = await getSubscription(id);
    if (s) out.push(s);
  }
  return out.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

/* --------------------------------- writes --------------------------------- */

async function persist(sub: Subscription, entry: Omit<SubHistoryEntry, "ts">, before: Subscription | null): Promise<void> {
  const now = Date.now();
  await kv.set(subKey(sub.userId), JSON.stringify(sub));
  const full: SubHistoryEntry = { ts: now, ...entry, before: summarize(before), after: summarize(sub) };
  await kv.lpush(histKey(sub.userId), JSON.stringify(full));
  await kv.ltrim(histKey(sub.userId), 0, MAX_HISTORY - 1);
  await kv.sadd(USERS, sub.userId);
  if (hasAccess(sub, now) && sub.periodEnd != null) await kv.zadd(BY_END, { score: sub.periodEnd, member: sub.userId });
  else await kv.zrem(BY_END, sub.userId);
  if (sub.endedAt) await kv.zadd(ENDED, { score: sub.endedAt, member: sub.userId });
  else await kv.zrem(ENDED, sub.userId);
  await recordSubscriptionChange(entry.action, before, sub, entry.by);
}

/**
 * Make Clerk say what the record says. Throws OwnerProtected for the owner,
 * and lets a Clerk failure through so the caller does not record a change
 * that enforcement never saw.
 */
export async function syncClerk(sub: Subscription): Promise<{ email: string }> {
  const client = await clerkClient();
  const user = await client.users.getUser(sub.userId);
  if (isOwnerEmailList(user.emailAddresses as ClerkEmailish[])) throw new OwnerProtected();
  const meta = { ...((user.publicMetadata ?? {}) as Record<string, unknown>) };
  if (hasAccess(sub, Date.now())) {
    meta.plan = sub.baseTier;
    meta.planExpiresAt = sub.periodEnd ?? null;
    meta.planId = sub.planId;
    meta.planVersion = sub.version;
    meta.planLimits = effectiveLimits(sub);
  } else {
    meta.plan = "free";
    meta.planExpiresAt = null;
    meta.planId = null;
    meta.planVersion = null;
    meta.planLimits = null;
  }
  await client.users.updateUserMetadata(sub.userId, { publicMetadata: meta });
  const u = user as { primaryEmailAddress?: { emailAddress?: string } | null; emailAddresses?: { emailAddress: string }[] };
  return { email: (u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || "").toLowerCase() };
}

async function commit(next: Subscription, before: Subscription | null, entry: Omit<SubHistoryEntry, "ts" | "before" | "after">) {
  await syncClerk(next);
  await persist(next, { ...entry, before: null, after: null }, before);
}

/* --------------------------------- planning -------------------------------- */

export type SubActionInput =
  | { action: "assign"; planId: string; cycle: Cycle; trial?: boolean; days?: number | null; paid?: { amount: number; currency: CurrencyCode } | null }
  | { action: "change"; planId: string; cycle: Cycle; when: "now" | "period_end"; newPeriod?: boolean; paid?: { amount: number; currency: CurrencyCode } | null }
  | { action: "extend"; days: number }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "cancel"; when: "now" | "period_end" }
  | { action: "comp"; planId: string; days: number | null }
  | {
      action: "custom";
      planId: string;
      days: number | null;
      limits?: Record<string, unknown>;
      price?: { amount: number; currency: CurrencyCode; cycle: Cycle | "one-off" } | null;
      notes?: string;
    }
  | { action: "addons"; addOnIds: string[] }
  | { action: "unschedule" };

export const SUB_ACTIONS = ["assign", "change", "extend", "pause", "resume", "cancel", "comp", "custom", "addons", "unschedule"] as const;

export type PlannedChange =
  | {
      ok: true;
      next: Subscription;
      summary: string;
      /** Plain-language consequences, shown before confirming. */
      lines: string[];
      proration?: { direction: "upgrade" | "downgrade" | "switch"; remainingMs: number; creditMs: number; oldDaily: number; newDaily: number };
    }
  | { ok: false; error: string; message: string };

const no = (error: string, message: string): PlannedChange => ({ ok: false, error, message });
const date = (ms: number | null) => (ms == null ? "no end date" : new Date(ms).toISOString().slice(0, 10));

function snapshotOf(v: PlanVersion): Subscription["snapshot"] {
  return { name: v.name, prices: v.prices, limits: v.limits };
}

async function sellablePlan(planId: string): Promise<{ plan: CatalogPlan } | { error: PlannedChange }> {
  const plan = await getPlan(planId);
  if (!plan) return { error: no("unknown_plan", "There is no plan with that id.") };
  if (plan.archived) return { error: no("plan_archived", `"${plan.current.name}" is archived. Unarchive it in Plans first.`) };
  if (plan.baseTier === "free") return { error: no("free_is_no_subscription", "Free is what an account has without a subscription. Cancel the subscription instead.") };
  return { plan };
}

function fresh(userId: string, email: string, plan: CatalogPlan, now: number): Subscription {
  return {
    userId,
    email,
    planId: plan.id,
    baseTier: plan.baseTier,
    version: plan.current.version,
    snapshot: snapshotOf(plan.current),
    status: "active",
    cycle: null,
    periodStart: now,
    periodEnd: null,
    source: "admin",
    pricePaid: null,
    couponCode: null,
    addOns: [],
    custom: null,
    paused: null,
    cancelled: null,
    scheduled: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function cleanDays(v: unknown): number | null | "bad" {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : "bad";
}

function cleanPaid(v: unknown): { amount: number; currency: CurrencyCode } | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const amount = Number(r.amount);
  if (!Number.isFinite(amount) || amount < 0 || !isCurrency(r.currency)) return null;
  return { amount: Math.round(amount * 100) / 100, currency: r.currency };
}

/**
 * Work out what an action would do, without writing anything. The admin
 * screen shows `lines` and asks for confirmation; the same call then
 * commits it (commitPlanned).
 */
export async function planAction(
  userId: string,
  email: string,
  current: Subscription | null,
  raw: Record<string, unknown>,
  actor: Actor,
  now = Date.now(),
): Promise<PlannedChange> {
  const action = raw.action as SubActionInput["action"];
  const live = hasAccess(current, now);
  const base = current ? { ...current, email: email || current.email, updatedAt: now } : null;

  switch (action) {
    case "assign": {
      const got = await sellablePlan(String(raw.planId ?? ""));
      if ("error" in got) return got.error;
      const { plan } = got;
      if (current && (live || current.status === "paused")) {
        return no("already_subscribed", "This account already has a subscription. Use Change plan, or cancel it first.");
      }
      if (!isCycle(raw.cycle)) return no("bad_cycle", "Choose monthly or annual.");
      const cycle = raw.cycle;
      const days = cleanDays(raw.days);
      if (days === "bad") return no("bad_days", "Days must be a whole number from 1 to 3650.");
      const next = fresh(userId, email, plan, now);
      next.createdAt = current?.createdAt ?? now;
      next.cycle = cycle;
      const lines: string[] = [];
      if (raw.trial === true) {
        // The platform trial policy (Settings → Registration) can turn
        // trials off, and gives the length when the plan sets none.
        const policy = await getTrialPolicy();
        if (!policy.enabled) return no("trials_disabled", "Free trials are turned off in Settings → Registration. Turn them on there, or assign the plan without a trial.");
        const trialDays = plan.current.trialDays || policy.defaultDays;
        if (!trialDays) return no("no_trial", `"${plan.current.name}" has no trial and the platform default is 0 days. Set trial days on the plan or in Settings first.`);
        next.status = "trialing";
        next.periodEnd = now + trialDays * DAY_MS;
        const length = plan.current.trialDays ? `${trialDays}-day` : `${trialDays}-day (the platform default)`;
        lines.push(`A ${length} trial of ${plan.current.name}, ending ${date(next.periodEnd)}. When it ends the account goes back to Free unless it is paid for.`);
      } else {
        next.periodEnd = now + (days ?? CYCLE_DAYS[cycle]) * DAY_MS;
        next.pricePaid = cleanPaid(raw.paid);
        lines.push(`${plan.current.name} (v${plan.current.version}, ${cycle}) from now until ${date(next.periodEnd)}.`);
        lines.push(next.pricePaid ? `Recorded as paid off-band: ${next.pricePaid.amount} ${next.pricePaid.currency}.` : "No payment is recorded. eSPees cannot charge automatically: collect it off-band, or use Complimentary if it is free.");
      }
      return { ok: true, next, summary: `Assigned ${plan.current.name} (${cycle})`, lines };
    }

    case "change": {
      if (!base || !live) return no("no_subscription", "There is no running subscription to change. Assign a plan instead.");
      if (base.status === "cancelled") return no("cancelled", "This subscription is cancelled. Resume it first, or assign a new plan after it ends.");
      const got = await sellablePlan(String(raw.planId ?? ""));
      if ("error" in got) return got.error;
      const { plan } = got;
      if (!isCycle(raw.cycle)) return no("bad_cycle", "Choose monthly or annual.");
      const cycle = raw.cycle;
      if (plan.id === base.planId && cycle === base.cycle) return no("same_plan", "That is the current plan and cycle. Use Extend to add time.");
      const oldDaily = dailyPrice(base);
      const listNew = espPrice(plan.current.prices, cycle);
      const newDaily = listNew ? listNew / CYCLE_DAYS[cycle] : 0;
      const direction = newDaily > oldDaily ? "upgrade" : newDaily < oldDaily ? "downgrade" : "switch";
      const when = raw.when === "now" || raw.when === "period_end" ? raw.when : direction === "downgrade" ? "period_end" : "now";
      if (when === "period_end") {
        if (base.periodEnd == null) return no("no_period_end", "This subscription has no end date, so there is no period end to wait for. Apply the change now.");
        const next: Subscription = {
          ...base,
          scheduled: { kind: "change", planId: plan.id, version: plan.current.version, cycle, effectiveAt: base.periodEnd, by: actor.email },
        };
        return {
          ok: true,
          next,
          summary: `Scheduled ${plan.current.name} (${cycle}) for ${date(base.periodEnd)}`,
          lines: [
            `Keeps ${base.snapshot.name} until ${date(base.periodEnd)}; no refund for the rest of this period.`,
            `On ${date(base.periodEnd)} the daily job moves the account to ${plan.current.name} v${plan.current.version} for a new ${CYCLE_DAYS[cycle]}-day period.`,
            "eSPees cannot charge automatically: collect that period's payment off-band, or it is in effect complimentary.",
          ],
          proration: { direction, remainingMs: base.periodEnd - now, creditMs: 0, oldDaily, newDaily },
        };
      }
      const remainingMs = base.periodEnd == null ? 0 : Math.max(0, base.periodEnd - now);
      const creditMs = convertRemaining(remainingMs, oldDaily, newDaily);
      const newPeriod = raw.newPeriod === true;
      const periodEnd = now + (newPeriod ? CYCLE_DAYS[cycle] * DAY_MS : 0) + creditMs;
      if (periodEnd <= now) {
        return no(
          "nothing_to_convert",
          newDaily === 0
            ? `${plan.current.name} has no ESP price for ${cycle} billing, so unused time cannot be converted into it. Tick "start a new period", or use Complimentary / Custom.`
            : remainingMs > 0
              ? `The ${fmtDays(remainingMs)} left on ${base.snapshot.name} have no recorded price (${base.source === "backfill" ? "recorded from Clerk without a payment" : base.source}), so they cannot be valued. Tick "start a new period" (paid off-band), or schedule the change for the period end.`
              : 'There is no paid time left to convert. Tick "start a new period" (paid off-band), or use Assign after cancelling.',
        );
      }
      const paid = cleanPaid(raw.paid) ?? (listNew ? { amount: listNew, currency: "ESP" as const } : null);
      const next: Subscription = {
        ...base,
        planId: plan.id,
        baseTier: plan.baseTier,
        version: plan.current.version,
        snapshot: snapshotOf(plan.current),
        status: "active",
        cycle,
        periodStart: now,
        periodEnd,
        source: "admin",
        pricePaid: paid,
        custom: null,
        scheduled: null,
        cancelled: null,
        addOns: base.addOns,
      };
      const lines = [
        `${direction === "upgrade" ? "Upgrade" : direction === "downgrade" ? "Downgrade" : "Change"} to ${plan.current.name} v${plan.current.version} (${cycle}), now.`,
        remainingMs > 0
          ? creditMs > 0
            ? `${fmtDays(remainingMs)} left on ${base.snapshot.name} at ${oldDaily.toFixed(2)} ESP/day = ${fmtDays(creditMs)} on ${plan.current.name} at ${newDaily.toFixed(2)} ESP/day.`
            : `${fmtDays(remainingMs)} left on ${base.snapshot.name} ${oldDaily === 0 ? "were not paid for" : "cannot be valued"}, so they are not converted.`
          : "No unused paid time to convert.",
        newPeriod ? `Plus a new ${CYCLE_DAYS[cycle]}-day period${paid ? ` (record: ${paid.amount} ${paid.currency} paid off-band)` : ""}.` : "No new period is added: the converted days are the whole period.",
        `New period end: ${date(periodEnd)}. Nothing is charged or refunded — eSPees cannot do either automatically.`,
      ];
      if (base.custom) lines.push("The custom arrangement on this account ends with the change.");
      return { ok: true, next, summary: `Changed to ${plan.current.name} (${cycle})`, lines, proration: { direction, remainingMs, creditMs, oldDaily, newDaily } };
    }

    case "extend": {
      if (!base || base.status === "expired" || (!live && base.status !== "paused")) return no("no_subscription", "There is no running subscription to extend. Assign a plan instead.");
      const days = cleanDays(raw.days);
      if (days === null || days === "bad") return no("bad_days", "Days must be a whole number from 1 to 3650.");
      const add = days * DAY_MS;
      if (base.status === "paused" && base.paused) {
        if (base.paused.remainingMs == null) return no("no_period_end", "This subscription has no end date to extend.");
        const next = { ...base, paused: { ...base.paused, remainingMs: base.paused.remainingMs + add } };
        return { ok: true, next, summary: `Extended by ${days} days (while paused)`, lines: [`Adds ${days} days to the time left when it resumes (${fmtDays(next.paused.remainingMs)}).`] };
      }
      if (base.periodEnd == null) return no("no_period_end", "This subscription has no end date to extend.");
      const periodEnd = base.periodEnd + add;
      const next = { ...base, periodEnd, scheduled: base.scheduled ? { ...base.scheduled, effectiveAt: periodEnd } : null };
      return { ok: true, next, summary: `Extended by ${days} days`, lines: [`Period end moves from ${date(base.periodEnd)} to ${date(periodEnd)}. Nothing is charged.`] };
    }

    case "pause": {
      if (!base || !live) return no("no_subscription", "Only a running subscription can be paused.");
      if (base.status === "cancelled") return no("cancelled", "A cancelled subscription cannot be paused.");
      const remainingMs = base.periodEnd == null ? null : base.periodEnd - now;
      const next: Subscription = { ...base, status: "paused", paused: { at: now, remainingMs, prevStatus: base.status } };
      return {
        ok: true,
        next,
        summary: "Paused",
        lines: [
          "The account is on Free until it is resumed.",
          remainingMs == null ? "It has no end date, so none is kept." : `${fmtDays(remainingMs)} of the period are kept and start again on resume.`,
          "eSPees never charges automatically, so there is no billing to stop.",
        ],
      };
    }

    case "resume": {
      if (base?.status === "paused" && base.paused) {
        const periodEnd = base.paused.remainingMs == null ? null : now + base.paused.remainingMs;
        const next: Subscription = {
          ...base,
          status: base.paused.prevStatus,
          paused: null,
          periodEnd,
          scheduled: base.scheduled && periodEnd ? { ...base.scheduled, effectiveAt: periodEnd } : null,
        };
        return { ok: true, next, summary: "Resumed", lines: [`${base.snapshot.name} again, until ${date(periodEnd)}.`] };
      }
      if (base?.status === "cancelled" && base.cancelled?.atPeriodEnd && live) {
        const next: Subscription = { ...base, status: base.cancelled.prevStatus, cancelled: null };
        return { ok: true, next, summary: "Cancellation withdrawn", lines: [`The cancellation is withdrawn; ${base.snapshot.name} continues to ${date(base.periodEnd)}.`] };
      }
      return no("not_paused", "This subscription is not paused or waiting to cancel.");
    }

    case "cancel": {
      if (!base || base.status === "expired" || (!live && base.status !== "paused")) return no("no_subscription", "There is no running subscription to cancel.");
      if (raw.when === "period_end") {
        if (base.status === "paused") return no("paused", "Resume it first, or cancel now.");
        if (base.status === "cancelled") return no("cancelled", "It is already cancelled.");
        if (base.periodEnd == null) return no("no_period_end", "This subscription has no end date. Cancel now instead.");
        const next: Subscription = { ...base, status: "cancelled", cancelled: { at: now, prevStatus: base.status, atPeriodEnd: true }, scheduled: null };
        return {
          ok: true,
          next,
          summary: "Cancelled at period end",
          lines: [`Keeps ${base.snapshot.name} until ${date(base.periodEnd)}, then goes back to Free.`, base.scheduled ? "The scheduled plan change is dropped." : "Nothing renews automatically anyway."],
        };
      }
      const next: Subscription = {
        ...base,
        status: "cancelled",
        cancelled: { at: now, prevStatus: base.status === "paused" ? base.paused?.prevStatus ?? "active" : base.status, atPeriodEnd: false },
        periodEnd: now,
        endedAt: now,
        paused: null,
        scheduled: null,
      };
      return {
        ok: true,
        next,
        summary: "Cancelled now",
        lines: [
          "The account goes back to Free now.",
          base.periodEnd && base.periodEnd > now ? `${fmtDays(base.periodEnd - now)} of paid time are given up.` : "No paid time is left.",
          "No refund is made: eSPees cannot refund automatically. Refund off-band if one is owed.",
        ],
      };
    }

    case "comp": {
      const got = await sellablePlan(String(raw.planId ?? ""));
      if ("error" in got) return got.error;
      const { plan } = got;
      const days = cleanDays(raw.days);
      if (days === "bad") return no("bad_days", "Days must be a whole number from 1 to 3650, or empty for no end.");
      const next = fresh(userId, email, plan, now);
      Object.assign(next, {
        status: "complimentary",
        source: "complimentary",
        periodEnd: days ? now + days * DAY_MS : null,
        addOns: base?.addOns ?? [],
        createdAt: current?.createdAt ?? now,
      });
      const lines = [`${plan.current.name} v${plan.current.version} free of charge, ${days ? `until ${date(next.periodEnd)}` : "with no end date"}.`];
      if (live && base && base.status !== "complimentary") lines.push(`Replaces ${base.snapshot.name}; unused paid days are not converted.`);
      return { ok: true, next, summary: `Complimentary ${plan.current.name}${days ? ` for ${days} days` : ""}`, lines };
    }

    case "custom": {
      const got = await sellablePlan(String(raw.planId ?? "enterprise"));
      if ("error" in got) return got.error;
      const { plan } = got;
      const days = cleanDays(raw.days);
      if (days === "bad") return no("bad_days", "Days must be a whole number from 1 to 3650, or empty for no end.");
      const notes = typeof raw.notes === "string" ? raw.notes.trim().slice(0, 1000) : "";
      const p = raw.price && typeof raw.price === "object" ? (raw.price as Record<string, unknown>) : null;
      let price: NonNullable<Subscription["custom"]>["price"] = null;
      if (p && p.amount !== undefined && p.amount !== "") {
        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount < 0 || !isCurrency(p.currency)) return no("bad_price", "Give the price as an amount and a currency.");
        const pc = p.cycle === "one-off" || isCycle(p.cycle) ? (p.cycle as Cycle | "one-off") : "one-off";
        price = { amount: Math.round(amount * 100) / 100, currency: p.currency, cycle: pc };
      }
      const limits = mergeLimits(plan.current.limits, raw.limits);
      const overrides: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(limits)) if (plan.current.limits[k as keyof typeof limits] !== v) overrides[k] = v;
      const next = fresh(userId, email, plan, now);
      Object.assign(next, {
        source: "custom",
        status: "active",
        cycle: price && price.cycle !== "one-off" ? price.cycle : null,
        periodEnd: days ? now + days * DAY_MS : null,
        pricePaid: price ? { amount: price.amount, currency: price.currency } : null,
        custom: { limits: overrides, price, notes },
        addOns: base?.addOns ?? [],
        createdAt: current?.createdAt ?? now,
      });
      const lines = [
        `Custom arrangement on ${plan.current.name}, ${days ? `until ${date(next.periodEnd)}` : "with no end date"}.`,
        Object.keys(overrides).length ? `Limits changed from the plan: ${Object.entries(overrides).map(([k, v]) => `${k} = ${v}`).join(", ")}.` : "The plan's limits, unchanged.",
        price ? `Agreed price: ${price.amount} ${price.currency} ${price.cycle}${price.currency === "ESP" ? "" : " (not connected to a payment gateway)"} — collected off-band.` : "No price recorded.",
      ];
      if (live && base && base.source !== "custom") lines.push(`Replaces ${base.snapshot.name}; unused paid days are not converted.`);
      return { ok: true, next, summary: `Custom ${plan.current.name}`, lines };
    }

    case "addons": {
      if (!base || base.status === "expired" || (!live && base.status !== "paused")) return no("no_subscription", "Add-ons go on a running subscription.");
      const ids = Array.isArray(raw.addOnIds) ? [...new Set(raw.addOnIds.filter((x): x is string => typeof x === "string"))] : [];
      const attached: AttachedAddOn[] = [];
      for (const id of ids) {
        const kept = base.addOns.find((a) => a.id === id);
        if (kept) {
          attached.push(kept);
          continue;
        }
        const a = await getAddOn(id);
        if (!a || a.archived) return no("unknown_addon", `Add-on ${id} does not exist or is archived.`);
        if (a.planIds.length && !a.planIds.includes(base.planId)) return no("addon_not_for_plan", `"${a.name}" is not offered with ${base.snapshot.name}.`);
        attached.push({ id: a.id, name: a.name, grants: a.grants, attachedAt: now });
      }
      const next = { ...base, addOns: attached };
      const added = attached.filter((a) => !base.addOns.some((b) => b.id === a.id)).map((a) => a.name);
      const removed = base.addOns.filter((b) => !attached.some((a) => a.id === b.id)).map((a) => a.name);
      return {
        ok: true,
        next,
        summary: "Add-ons changed",
        lines: [added.length ? `Adds: ${added.join(", ")}.` : "", removed.length ? `Removes: ${removed.join(", ")}.` : "", "Add-ons are recorded and enforced; charge for them off-band."].filter(Boolean),
      };
    }

    case "unschedule": {
      if (!base?.scheduled) return no("nothing_scheduled", "There is no scheduled change.");
      return { ok: true, next: { ...base, scheduled: null }, summary: "Scheduled change withdrawn", lines: [`${base.snapshot.name} continues; the change to ${base.scheduled.planId} is withdrawn.`] };
    }

    default:
      return no("bad_action", "Unknown action.");
  }
}

export async function commitPlanned(
  next: Subscription,
  before: Subscription | null,
  actor: Actor,
  action: string,
  summary: string,
  note?: string,
): Promise<Subscription> {
  await commit(next, before, { action, by: actor, summary, ...(note ? { note } : {}) });
  return next;
}

/* --------------------------------- purchase -------------------------------- */

/**
 * A completed eSPees checkout: the version bought, for one cycle, applying
 * the proration rule — the same plan again extends from the current period
 * end; a different plan converts the unused days. Throws if Clerk cannot be
 * updated (the return route then marks the payment failed, as before).
 */
export async function applyPurchase(input: {
  userId: string;
  email?: string;
  planId: string;
  version?: number;
  cycle: Cycle;
  amountEsp: number;
  couponCode?: string | null;
  now?: number;
}): Promise<{ sub: Subscription; periodEnd: number; lines: string[] }> {
  const now = input.now ?? Date.now();
  const plan = await getPlan(input.planId);
  if (!plan) throw new Error(`unknown plan ${input.planId}`);
  const version = (input.version ? await getVersion(plan.id, input.version) : null) ?? plan.current;
  const current = await getSubscription(input.userId);
  const cycleMs = CYCLE_DAYS[input.cycle] * DAY_MS;
  const running = hasAccess(current, now) || current?.status === "paused";
  let periodEnd = now + cycleMs;
  const lines: string[] = [];
  let renewal = false;
  if (current && running) {
    if (current.planId === plan.id && current.cycle === input.cycle && current.status !== "paused") {
      renewal = true;
      periodEnd = Math.max(now, current.periodEnd ?? now) + cycleMs;
      lines.push(`Renewal: the new period starts when the current one ends (${date(current.periodEnd)}).`);
    } else {
      const remaining = current.status === "paused" ? current.paused?.remainingMs ?? 0 : current.periodEnd == null ? 0 : current.periodEnd - now;
      const credit = convertRemaining(remaining, dailyPrice(current), input.amountEsp / CYCLE_DAYS[input.cycle]);
      periodEnd += credit;
      if (credit) lines.push(`${fmtDays(remaining)} left on ${current.snapshot.name} converted to ${fmtDays(credit)}.`);
    }
  }
  const next: Subscription = {
    ...(current ?? fresh(input.userId, input.email ?? "", plan, now)),
    email: input.email || current?.email || "",
    planId: plan.id,
    baseTier: plan.baseTier,
    version: version.version,
    snapshot: snapshotOf(version),
    status: "active",
    cycle: input.cycle,
    periodStart: renewal ? current!.periodStart : now,
    periodEnd,
    source: "espees",
    pricePaid: { amount: input.amountEsp, currency: "ESP" },
    couponCode: input.couponCode ?? null,
    addOns: current?.addOns ?? [],
    custom: renewal ? current?.custom ?? null : null,
    paused: null,
    cancelled: null,
    scheduled: renewal ? current?.scheduled ?? null : null,
    endedAt: null,
    updatedAt: now,
  };
  if (next.scheduled) next.scheduled = { ...next.scheduled, effectiveAt: periodEnd };
  // Clerk first: it is what enforcement reads, and a failure there means the
  // purchase did not land. Once it has, a KV hiccup must not report the
  // payment as failed, so the record write only logs.
  const { email } = await syncClerk(next);
  if (!next.email) next.email = email;
  try {
    await persist(
      next,
      {
        action: renewal ? "purchase.renew" : "purchase",
        by: { userId: input.userId, email: input.email || "the account holder" },
        summary: `Bought ${version.name} (${input.cycle}) for ${input.amountEsp} ESP via eSPees${input.couponCode ? ` with coupon ${input.couponCode}` : ""}`,
        before: null,
        after: null,
      },
      current,
    );
  } catch (e) {
    console.error("[subscriptions] purchase applied in Clerk but the record write failed", input.userId, e);
  }
  return { sub: next, periodEnd, lines };
}

/* ------------------------------ plan migration ----------------------------- */

export interface MigrationRow {
  userId: string;
  email: string;
  status: Subscription["status"];
  fromVersion: number;
  changes: Record<string, [unknown, unknown]>;
}

/**
 * Move the subscribers of `planId` on other versions (or only `fromVersions`)
 * to `toVersion`'s terms. Period, price paid and add-ons stay. With
 * `apply` false nothing is written: the rows are the preview.
 */
export async function migrateSubscribers(
  planId: string,
  toVersion: number,
  fromVersions: number[] | null,
  actor: Actor,
  apply: boolean,
): Promise<{ rows: MigrationRow[]; applied: number; failed: { userId: string; reason: string }[] } | { error: string; message: string }> {
  const target = await getVersion(planId, toVersion);
  if (!target) return { error: "unknown_version", message: `Plan ${planId} has no version ${toVersion}.` };
  const now = Date.now();
  const subs = (await listSubscriptions()).filter(
    (s) =>
      s.planId === planId &&
      s.version !== toVersion &&
      (!fromVersions || fromVersions.includes(s.version)) &&
      (hasAccess(s, now) || s.status === "paused"),
  );
  const rows: MigrationRow[] = subs.map((s) => {
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [k, v] of Object.entries(target.limits)) {
      const was = s.snapshot.limits[k as keyof typeof target.limits];
      if (was !== v) changes[k] = [was, v];
    }
    if (s.snapshot.name !== target.name) changes.name = [s.snapshot.name, target.name];
    return { userId: s.userId, email: s.email, status: s.status, fromVersion: s.version, changes };
  });
  if (!apply) return { rows, applied: 0, failed: [] };
  let applied = 0;
  const failed: { userId: string; reason: string }[] = [];
  for (const s of subs) {
    const next: Subscription = { ...s, version: toVersion, snapshot: snapshotOf(target), updatedAt: now };
    try {
      await commit(next, s, { action: "migrate", by: actor, summary: `Migrated from v${s.version} to v${toVersion}` });
      applied++;
    } catch (e) {
      failed.push({ userId: s.userId, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { rows, applied, failed };
}

/* -------------------------------- daily job -------------------------------- */

type DueChange =
  | { kind: "drop" }
  | { kind: "reindex"; periodEnd: number }
  | { kind: "apply_scheduled" | "expire"; sub: Subscription; next: Subscription; entry: Omit<SubHistoryEntry, "ts" | "before" | "after"> };

/** What the daily job does with one record found due in the period-end index. Reads only. */
async function dueChange(sub: Subscription | null, now: number): Promise<DueChange> {
  if (!sub || sub.periodEnd == null || sub.status === "paused" || sub.status === "expired") return { kind: "drop" };
  if (sub.periodEnd > now) return { kind: "reindex", periodEnd: sub.periodEnd };
  const s = sub.scheduled;
  if (s && sub.status !== "cancelled") {
    const plan = await getPlan(s.planId);
    const version = (await getVersion(s.planId, s.version)) ?? plan?.current;
    if (plan && version) {
      const listPrice = espPrice(version.prices, s.cycle);
      const next: Subscription = {
        ...sub,
        planId: plan.id,
        baseTier: plan.baseTier,
        version: version.version,
        snapshot: snapshotOf(version),
        status: "active",
        cycle: s.cycle,
        periodStart: sub.periodEnd,
        periodEnd: sub.periodEnd + CYCLE_DAYS[s.cycle] * DAY_MS,
        source: "admin",
        pricePaid: listPrice ? { amount: listPrice, currency: "ESP" } : null,
        custom: null,
        scheduled: null,
        updatedAt: now,
      };
      return {
        kind: "apply_scheduled",
        sub,
        next,
        entry: { action: "scheduled.apply", by: SYSTEM, summary: `Scheduled change applied: ${version.name} (${s.cycle})`, note: `scheduled by ${s.by}` },
      };
    }
  }
  return {
    kind: "expire",
    sub,
    next: { ...sub, status: "expired", endedAt: sub.periodEnd, scheduled: null, updatedAt: now },
    entry: { action: "expire", by: SYSTEM, summary: sub.status === "trialing" ? "Trial ended" : sub.status === "cancelled" ? "Cancellation took effect" : "Period ended" },
  };
}

export interface DueItem {
  userId: string;
  email: string;
  action: "apply_scheduled" | "expire";
  summary: string;
}

/**
 * What sweepDue would do at `now`, without doing it: one row per record it
 * would change. The same decision sweepDue makes, so a preview cannot drift
 * from the sweep.
 */
export async function planDue(now = Date.now()): Promise<DueItem[]> {
  const out: DueItem[] = [];
  for (const id of await idsByScore(BY_END, 0, now, 1000)) {
    const d = await dueChange(await getSubscription(id), now);
    if (d.kind === "apply_scheduled" || d.kind === "expire") out.push({ userId: d.sub.userId, email: d.sub.email, action: d.kind, summary: d.entry.summary });
  }
  return out;
}

/**
 * Called by /api/cron/downgrade-expired-plans before its Clerk sweep: every
 * record whose period has ended either starts its scheduled plan or ends
 * (trials and cancellations included) and goes back to Free.
 */
export async function sweepDue(now = Date.now()): Promise<{ changed: number; expired: number; errors: { userId: string; reason: string }[] }> {
  let changed = 0;
  let expired = 0;
  const errors: { userId: string; reason: string }[] = [];
  for (const id of await idsByScore(BY_END, 0, now, 1000)) {
    try {
      const d = await dueChange(await getSubscription(id), now);
      if (d.kind === "drop") await kv.zrem(BY_END, id);
      else if (d.kind === "reindex") await kv.zadd(BY_END, { score: d.periodEnd, member: id });
      else {
        await commit(d.next, d.sub, d.entry);
        if (d.kind === "apply_scheduled") changed++;
        else expired++;
      }
    } catch (e) {
      errors.push({ userId: id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { changed, expired, errors };
}

/* ------------------------- other phases' entry points ---------------------- */

/**
 * End an account's plan now, for a refund (admin billing). A running
 * subscription is cancelled as "Cancel now" does: Free at once, a history
 * entry, Clerk synced, planLimits cleared. An account with a paid plan in
 * Clerk but no record (from before the catalog) has its plan cleared in
 * Clerk the way the downgrade cron does. Throws OwnerProtected for the
 * platform owner. The caller writes the admin audit entry.
 */
export async function endSubscriptionNow(
  userId: string,
  opts: { actor: Actor; reason: string },
): Promise<{ ended: "subscription" | "clerk_only" | "nothing"; subscription: Subscription | null }> {
  const now = Date.now();
  const current = await getSubscription(userId);
  if (current && (hasAccess(current, now) || current.status === "paused")) {
    const planned = await planAction(userId, current.email, current, { action: "cancel", when: "now" }, opts.actor, now);
    if (!planned.ok) throw new Error(planned.message);
    await commit(planned.next, current, { action: "admin.cancel", by: opts.actor, summary: "Cancelled now", note: opts.reason });
    return { ended: "subscription", subscription: planned.next };
  }
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  if (isOwnerEmailList(user.emailAddresses as ClerkEmailish[])) throw new OwnerProtected();
  const meta = { ...((user.publicMetadata ?? {}) as Record<string, unknown>) };
  if (!meta.plan || meta.plan === "free") return { ended: "nothing", subscription: current };
  await client.users.updateUserMetadata(userId, {
    publicMetadata: { ...meta, plan: "free", planExpiresAt: null, planId: null, planVersion: null, planLimits: null },
  });
  return { ended: "clerk_only", subscription: current };
}

/**
 * Account deletion (data governance): remove the live record and every index
 * and coupon-use entry that names the account. The history is kept as a
 * billing record, detached: moved to an anonymous key, with the account's
 * own userId and email replaced wherever it is the actor (a self-serve
 * purchase). History entries hold no other personal fields: plan ids,
 * statuses, dates, amounts, coupon codes and administrators' emails.
 * Writes nothing to Clerk (the account is being deleted).
 */
export async function forgetSubscriptionUser(userId: string): Promise<{ removed: number; historyKey: string | null }> {
  let removed = 0;
  if (await kv.get(subKey(userId))) removed += Number(await kv.del(subKey(userId)));
  removed += Number(await kv.srem(USERS, userId));
  removed += Number(await kv.zrem(BY_END, userId));
  removed += Number(await kv.zrem(ENDED, userId));
  for (const c of await listCoupons()) removed += Number(await kv.srem(`neo:coupon:u:${c.code}`, userId));
  const history = await getHistory(userId, MAX_HISTORY);
  let historyKey: string | null = null;
  if (history.length) {
    historyKey = `neo:sub:h:forgotten:${crypto.randomUUID()}`;
    const anon = { userId: "forgotten", email: "deleted account" };
    // Oldest first, so LPUSH leaves the newest at the head as before.
    for (const e of [...history].reverse()) {
      await kv.lpush(historyKey, JSON.stringify(e.by.userId === userId ? { ...e, by: anon } : e));
    }
    removed += Number(await kv.del(histKey(userId)));
  }
  return { removed, historyKey };
}

/* --------------------------------- backfill -------------------------------- */

/**
 * One-off: a record for every account that has a paid plan in Clerk but no
 * record yet (everyone from before the catalog), on version 1 of its tier —
 * the terms it was sold. Writes nothing to Clerk: without a limits snapshot
 * enforcement already uses exactly version 1. Safe to run again.
 */
export async function backfillFromClerk(actor: Actor): Promise<{ scanned: number; created: number; skipped: number; owner: number }> {
  const client = await clerkClient();
  const now = Date.now();
  let offset = 0;
  let scanned = 0;
  let created = 0;
  let skipped = 0;
  let owner = 0;
  for (;;) {
    const page = (await client.users.getUserList({ limit: 500, offset })) as {
      data: { id: string; publicMetadata?: unknown; emailAddresses?: ClerkEmailish[]; primaryEmailAddress?: { emailAddress?: string } | null }[];
      totalCount: number;
    };
    for (const u of page.data) {
      scanned++;
      const meta = (u.publicMetadata ?? {}) as Record<string, unknown>;
      const tier = meta.plan;
      if (!isPlan(tier) || tier === "free") continue;
      if (isOwnerEmailList(u.emailAddresses)) {
        owner++;
        continue;
      }
      const expiresAt = typeof meta.planExpiresAt === "number" ? meta.planExpiresAt : null;
      if ((expiresAt != null && expiresAt <= now) || (await getSubscription(u.id))) {
        skipped++;
        continue;
      }
      const v1 = await getVersion(tier, 1);
      const plan = await getPlan(tier);
      if (!v1 || !plan) continue;
      const pay = (await listUserPayments(u.id, 1))[0];
      const email = u.primaryEmailAddress?.emailAddress ?? u.emailAddresses?.[0]?.emailAddress ?? "";
      const sub: Subscription = {
        ...fresh(u.id, email, plan, now),
        version: 1,
        snapshot: snapshotOf(v1),
        status: expiresAt == null ? "complimentary" : "active",
        cycle: pay && isCycle(pay.billingCycle) ? pay.billingCycle : null,
        periodStart: pay?.periodStart ?? now,
        periodEnd: expiresAt,
        source: "backfill",
        pricePaid: pay ? { amount: pay.amountEsp, currency: "ESP" } : null,
      };
      await persist(sub, { action: "backfill", by: actor, summary: `Recorded from Clerk: ${tier}${expiresAt ? ` until ${date(expiresAt)}` : ", no end date"}`, before: null, after: null }, null);
      created++;
    }
    offset += page.data.length;
    if (!page.data.length || offset >= page.totalCount || offset >= 20_000) break;
  }
  return { scanned, created, skipped, owner };
}

// src/lib/billing/model.ts
//
// The plan catalog, coupons, offers, add-ons and subscriptions as data, and
// the arithmetic on them (discounts, proration). Pure — no KV, no Clerk — so
// the admin screens and /pricing can import it. Storage is in ./store.ts and
// ./subscriptions.ts.
//
// Plan ids. The five tiers (free, starter, pro, business, enterprise) are
// plans in the catalog under their own ids, so everything that already
// switches on `Plan` keeps working. A plan made in the admin gets its own id
// and names a base tier: Clerk publicMetadata.plan holds the base tier,
// which is what every `Plan` code path sees (labels, "is this a paid plan",
// the pricing card it resembles), while the limits it enforces come from the
// plan's own version, written to publicMetadata.planLimits. So a custom plan
// is "a <base tier> account with these limits".
//
// Versions. A plan's terms (name, description, prices, trial, limits) are
// versioned: saving them makes a new version and new purchases get it.
// A subscription keeps a snapshot of the version it was bought on until an
// administrator migrates it (previewed, then confirmed). Ordering,
// archiving and whether a plan is sold are settings, not terms.

import { ESPEES_AMOUNTS } from "@/lib/espees";
import {
  PLANS,
  extendedLimits,
  isPlan,
  mergeLimits,
  type Plan,
  type PlanFeatureLimits,
} from "@/lib/planLimits";

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Cycle = "monthly" | "annual";
export const CYCLES: Cycle[] = ["monthly", "annual"];
/** As computePlanExpiry: a month is 30 days, a year 365. */
export const CYCLE_DAYS: Record<Cycle, number> = { monthly: 30, annual: 365 };

export function isCycle(v: unknown): v is Cycle {
  return v === "monthly" || v === "annual";
}

/* -------------------------------- currencies ------------------------------ */

/**
 * ESP is the only currency a payment gateway takes today (eSPees). The
 * others can be configured and shown, and are labelled as not connected.
 */
export const CURRENCIES = [
  { code: "ESP", label: "Espees (ESP)", live: true, gateway: "eSPees" },
  { code: "USD", label: "US dollar (USD)", live: false, gateway: null },
  { code: "EUR", label: "Euro (EUR)", live: false, gateway: null },
  { code: "GBP", label: "Pound sterling (GBP)", live: false, gateway: null },
  { code: "NGN", label: "Nigerian naira (NGN)", live: false, gateway: null },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];
export const LIVE_CURRENCY: CurrencyCode = "ESP";
export const NOT_CONNECTED = "not connected to a payment gateway";

export function isCurrency(v: unknown): v is CurrencyCode {
  return typeof v === "string" && CURRENCIES.some((c) => c.code === v);
}

/** null = this cycle is not offered in this currency. */
export type CyclePrice = { monthly: number | null; annual: number | null };
export type Prices = Partial<Record<CurrencyCode, CyclePrice>>;

function money(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 10_000_000) return null;
  return Math.round(n * 100) / 100;
}

export function cleanPrices(raw: unknown): Prices {
  const out: Prices = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [code, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!isCurrency(code) || !p || typeof p !== "object") continue;
    const monthly = money((p as Record<string, unknown>).monthly);
    const annual = money((p as Record<string, unknown>).annual);
    if (monthly === null && annual === null) continue;
    out[code] = { monthly, annual };
  }
  return out;
}

/** The ESP price of a cycle, or null when it cannot be bought with eSPees. */
export function espPrice(prices: Prices, cycle: Cycle): number | null {
  const p = prices.ESP?.[cycle];
  return typeof p === "number" && p > 0 ? p : null;
}

/* ---------------------------------- limits -------------------------------- */

export type LimitKey = keyof PlanFeatureLimits;

export interface LimitField {
  key: LimitKey;
  label: string;
  kind: "number" | "bool" | "nullable";
  unit?: string;
  /** What 0 (or null for `nullable`) means. */
  zero?: string;
  /** Whether the app refuses or stops something at this limit today. */
  enforced: boolean;
  /** Where it is enforced, or why it is not. */
  how: string;
}

export const SHOWN_NOT_ENFORCED = "shown, not enforced yet";

export const LIMIT_FIELDS: LimitField[] = [
  { key: "meetingMinutes", label: "Meeting length", kind: "number", unit: "minutes", zero: "unlimited", enforced: true, how: "The in-room countdown ends the meeting (from the host's token)." },
  { key: "maxParticipants", label: "Participants per meeting", kind: "number", zero: "unlimited", enforced: true, how: "Joining a full room is refused (LiveKit token)." },
  { key: "lifetimeMeetingCap", label: "Meetings ever created", kind: "number", zero: "unlimited", enforced: true, how: "Creating a meeting past the cap is refused." },
  { key: "recording", label: "Cloud recording", kind: "bool", enforced: true, how: "Starting a recording is refused without it." },
  { key: "recordingHoursPerMonth", label: "Recording hours per month", kind: "number", unit: "hours", zero: "unlimited", enforced: true, how: "New recordings wait for next month at the limit." },
  { key: "breakouts", label: "Breakout rooms", kind: "bool", enforced: true, how: "The breakout controls are hidden in the room." },
  { key: "translation", label: "Choose translation languages", kind: "bool", enforced: true, how: "Creating a meeting with languages is refused." },
  { key: "livestream", label: "Livestream (RTMP)", kind: "bool", enforced: true, how: "Going live and provisioning a stream are refused." },
  { key: "groupMembers", label: "Group members", kind: "nullable", zero: "same as participants", enforced: true, how: "Adding members past the limit is refused (capped at the platform's group maximum)." },
  { key: "branding", label: "Custom branding", kind: "bool", enforced: false, how: "Nothing checks this yet." },
  { key: "seats", label: "Host seats", kind: "number", zero: "unlimited", enforced: false, how: "Accounts have one host; there are no team seats yet." },
  { key: "storageGb", label: "Storage", kind: "number", unit: "GB", zero: "unlimited", enforced: true, how: "Uploads to meeting and group chat are refused once the account's stored files reach it. Recordings count towards it but are never stopped." },
];

export { mergeLimits, extendedLimits };

/* ----------------------------------- plans -------------------------------- */

export interface PlanDef {
  id: string;
  /** Which of the five tiers the rest of the app sees this plan as. */
  baseTier: Plan;
  archived: boolean;
  order: number;
  /** Can be bought at eSPees checkout (needs an ESP price). */
  selfServe: boolean;
  /** Listed on /pricing. */
  public: boolean;
  highlight: boolean;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

export interface PlanTerms {
  name: string;
  description: string;
  prices: Prices;
  trialDays: number;
  limits: PlanFeatureLimits;
}

export interface PlanVersion extends PlanTerms {
  planId: string;
  version: number;
  createdAt: number;
  createdBy: string;
  note?: string;
}

export interface CatalogPlan extends PlanDef {
  current: PlanVersion;
}

export const TIER_LABELS: Record<Plan, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
};

const TIER_DESCRIPTIONS: Record<Plan, string> = {
  free: "For quick chats and trying things out.",
  starter: "For solo creators and small group calls.",
  pro: "For freelancers, teachers, and small teams.",
  business: "For organizations that need polish and scale.",
  enterprise: "For schools, churches, and large organizations.",
};

export function isTierId(id: string): id is Plan {
  return isPlan(id);
}

/**
 * Version 1 of each tier: exactly what the app enforced and charged before
 * the catalog existed (getPlanLimits, ESPEES_AMOUNTS). An account without a
 * limits snapshot is on this.
 */
export function defaultTier(tier: Plan): { def: PlanDef; version: PlanVersion } {
  const esp =
    tier === "starter" || tier === "pro" || tier === "business"
      ? { monthly: ESPEES_AMOUNTS[tier].monthly, annual: ESPEES_AMOUNTS[tier].annual }
      : tier === "free"
        ? { monthly: 0, annual: 0 }
        : null;
  return {
    def: {
      id: tier,
      baseTier: tier,
      archived: false,
      order: PLANS.indexOf(tier),
      selfServe: tier === "starter" || tier === "pro" || tier === "business",
      public: true,
      highlight: tier === "pro",
      currentVersion: 1,
      createdAt: 0,
      updatedAt: 0,
      createdBy: "system",
    },
    version: {
      planId: tier,
      version: 1,
      name: TIER_LABELS[tier],
      description: TIER_DESCRIPTIONS[tier],
      prices: esp ? { ESP: esp } : {},
      trialDays: 0,
      limits: extendedLimits(tier),
      createdAt: 0,
      createdBy: "system",
      note: "Built-in terms from before the plan catalog.",
    },
  };
}

export const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export function slugPlanId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Validate and normalise plan terms from a form. Returns an error message or the terms. */
export function cleanTerms(raw: unknown, base: PlanTerms): PlanTerms | string {
  if (!raw || typeof raw !== "object") return "Send the plan's terms.";
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 60) : base.name;
  if (!name) return "A plan needs a name.";
  const description = typeof r.description === "string" ? r.description.trim().slice(0, 400) : base.description;
  const prices = r.prices === undefined ? base.prices : cleanPrices(r.prices);
  const trialRaw = r.trialDays === undefined ? base.trialDays : Number(r.trialDays);
  if (!Number.isInteger(trialRaw) || trialRaw < 0 || trialRaw > 365) return "Trial days must be a whole number from 0 to 365.";
  const limits = r.limits === undefined ? base.limits : mergeLimits(base.limits, r.limits);
  return { name, description, prices, trialDays: trialRaw, limits };
}

/** What differs between two sets of terms, as {field: [before, after]}. */
export function termsDiff(a: PlanTerms, b: PlanTerms): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of ["name", "description", "trialDays"] as const) if (a[k] !== b[k]) out[k] = [a[k], b[k]];
  if (JSON.stringify(a.prices) !== JSON.stringify(b.prices)) out.prices = [a.prices, b.prices];
  for (const f of LIMIT_FIELDS) {
    if (a.limits[f.key] !== b.limits[f.key]) out[`limits.${f.key}`] = [a.limits[f.key], b.limits[f.key]];
  }
  return out;
}

/* ------------------------- coupons, offers, add-ons ------------------------ */

export type DiscountKind = "percent" | "fixed";

export interface Discount {
  kind: DiscountKind;
  /** percent: 1–100; fixed: ESP off. */
  value: number;
}

export interface Coupon extends Discount {
  code: string;
  description: string;
  /** Empty = every plan. */
  planIds: string[];
  /** Empty = both cycles. */
  cycles: Cycle[];
  startsAt: number | null;
  expiresAt: number | null;
  maxRedemptions: number | null;
  oncePerUser: boolean;
  active: boolean;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
}

/** A discount without a code, applied at checkout while it runs. */
export interface Offer extends Discount {
  id: string;
  name: string;
  /** Shown on /pricing next to the plans it applies to. */
  label: string;
  planIds: string[];
  cycles: Cycle[];
  startsAt: number | null;
  endsAt: number | null;
  active: boolean;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
}

export type AddOnGrants = Partial<
  Pick<PlanFeatureLimits, "maxParticipants" | "recordingHoursPerMonth" | "seats" | "storageGb" | "groupMembers"> &
    Record<"recording" | "livestream" | "translation" | "breakouts" | "branding", boolean>
>;

export interface AddOn {
  id: string;
  name: string;
  description: string;
  prices: Prices;
  /** Numbers are added to the plan's limit (an unlimited 0 stays unlimited); true switches a feature on. */
  grants: AddOnGrants;
  /** Empty = every plan. */
  planIds: string[];
  archived: boolean;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
}

export const COUPON_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
export const MIN_CHARGE_ESP = 1;

export function cleanDiscount(r: Record<string, unknown>): Discount | string {
  const kind = r.kind === "fixed" ? "fixed" : r.kind === "percent" ? "percent" : null;
  if (!kind) return "Choose a percentage or a fixed amount off.";
  const value = Number(r.value);
  if (!Number.isFinite(value) || value <= 0) return "The discount must be more than 0.";
  if (kind === "percent" && value > 100) return "A percentage discount can be at most 100.";
  return { kind, value: Math.round(value * 100) / 100 };
}

export function cleanCycles(v: unknown): Cycle[] {
  return Array.isArray(v) ? [...new Set(v.filter(isCycle))] : [];
}

export function cleanIds(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && PLAN_ID_RE.test(x)))] : [];
}

export function cleanTime(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function cleanGrants(raw: unknown): AddOnGrants {
  const out: AddOnGrants = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const k of ["maxParticipants", "recordingHoursPerMonth", "seats", "storageGb", "groupMembers"] as const) {
    const n = Number(r[k]);
    if (r[k] !== undefined && r[k] !== null && r[k] !== "" && Number.isInteger(n) && n > 0) out[k] = n;
  }
  for (const k of ["recording", "livestream", "translation", "breakouts", "branding"] as const) if (r[k] === true) out[k] = true;
  return out;
}

/** The amount after a discount, rounded to cents, never below 0. */
export function discounted(amount: number, d: Discount): { discount: number; amount: number } {
  const off = d.kind === "percent" ? (amount * d.value) / 100 : d.value;
  const discount = Math.round(Math.min(amount, Math.max(0, off)) * 100) / 100;
  return { discount, amount: Math.round((amount - discount) * 100) / 100 };
}

const applies = (ids: string[], planId: string) => !ids.length || ids.includes(planId);
const cycleOk = (cs: Cycle[], c: Cycle) => !cs.length || cs.includes(c);

/** Why a coupon cannot be used here, or null when it can. */
export function couponProblem(
  c: Coupon,
  at: { planId: string; cycle: Cycle; now: number; redemptions: number; usedByUser: boolean },
): string | null {
  if (!c.active) return "This coupon is no longer active.";
  if (c.startsAt && at.now < c.startsAt) return "This coupon is not valid yet.";
  if (c.expiresAt && at.now > c.expiresAt) return "This coupon has expired.";
  if (c.maxRedemptions != null && at.redemptions >= c.maxRedemptions) return "This coupon has been used up.";
  if (c.oncePerUser && at.usedByUser) return "You have already used this coupon.";
  if (!applies(c.planIds, at.planId)) return "This coupon is not for this plan.";
  if (!cycleOk(c.cycles, at.cycle)) return `This coupon is not for ${at.cycle} billing.`;
  return null;
}

export function offerApplies(o: Offer, planId: string, cycle: Cycle, now: number): boolean {
  return (
    o.active &&
    (!o.startsAt || now >= o.startsAt) &&
    (!o.endsAt || now <= o.endsAt) &&
    applies(o.planIds, planId) &&
    cycleOk(o.cycles, cycle)
  );
}

/* ------------------------------- subscriptions ----------------------------- */

export type SubStatus = "trialing" | "active" | "paused" | "cancelled" | "expired" | "complimentary";
export const SUB_STATUSES: SubStatus[] = ["trialing", "active", "paused", "cancelled", "expired", "complimentary"];

export type SubSource = "espees" | "admin" | "complimentary" | "custom" | "backfill";

export interface AttachedAddOn {
  id: string;
  name: string;
  grants: AddOnGrants;
  attachedAt: number;
}

export interface CustomTerms {
  limits?: Partial<PlanFeatureLimits>;
  price?: { amount: number; currency: CurrencyCode; cycle: Cycle | "one-off" } | null;
  notes?: string;
}

export interface ScheduledChange {
  kind: "change";
  planId: string;
  version: number;
  cycle: Cycle;
  effectiveAt: number;
  by: string;
  note?: string;
}

export interface Subscription {
  userId: string;
  email: string;
  planId: string;
  baseTier: Plan;
  version: number;
  /** The version's terms as bought; a plan edit does not change them. */
  snapshot: { name: string; prices: Prices; limits: PlanFeatureLimits };
  status: SubStatus;
  /** null = no billing cycle (an open-ended grant). */
  cycle: Cycle | null;
  periodStart: number;
  /** null = no end. */
  periodEnd: number | null;
  source: SubSource;
  /** What was charged for the current period, after discounts. */
  pricePaid: { amount: number; currency: CurrencyCode } | null;
  couponCode?: string | null;
  addOns: AttachedAddOn[];
  custom: CustomTerms | null;
  /** Set while paused: how much of the period was left. */
  paused: { at: number; remainingMs: number | null; prevStatus: SubStatus } | null;
  /** Set by "cancel at period end": what to go back to if resumed before then. */
  cancelled: { at: number; prevStatus: SubStatus; atPeriodEnd: boolean } | null;
  scheduled: ScheduledChange | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SubHistoryEntry {
  ts: number;
  action: string;
  by: { userId: string; email: string };
  summary: string;
  before: SubSummary | null;
  after: SubSummary | null;
  note?: string;
}

/** The fields that say what someone has; used for history, audit and previews. */
export type SubSummary = Pick<Subscription, "planId" | "version" | "status" | "cycle" | "periodEnd" | "source"> & {
  scheduled: string | null;
  addOns: string[];
};

export function summarize(s: Subscription | null): SubSummary | null {
  if (!s) return null;
  return {
    planId: s.planId,
    version: s.version,
    status: s.status,
    cycle: s.cycle,
    periodEnd: s.periodEnd,
    source: s.source,
    scheduled: s.scheduled ? `${s.scheduled.planId} v${s.scheduled.version} (${s.scheduled.cycle}) at ${new Date(s.scheduled.effectiveAt).toISOString()}` : null,
    addOns: s.addOns.map((a) => a.id),
  };
}

/** Whether the subscription gives its plan right now. */
export function hasAccess(s: Subscription | null, now: number): boolean {
  if (!s) return false;
  if (s.status === "paused" || s.status === "expired") return false;
  return s.periodEnd == null || s.periodEnd > now;
}

/** Plan limits + add-ons + custom terms: what is written to Clerk and enforced. */
export function effectiveLimits(s: Pick<Subscription, "snapshot" | "addOns" | "custom">): PlanFeatureLimits {
  const out: PlanFeatureLimits = { ...s.snapshot.limits };
  for (const a of s.addOns) {
    for (const k of ["maxParticipants", "recordingHoursPerMonth", "seats", "storageGb"] as const) {
      const add = a.grants[k];
      if (add && out[k] !== 0) out[k] = out[k] + add;
    }
    if (a.grants.groupMembers && out.groupMembers !== 0) {
      const base = out.groupMembers ?? (out.maxParticipants || 0);
      out.groupMembers = base === 0 ? 0 : base + a.grants.groupMembers;
    }
    for (const k of ["recording", "livestream", "translation", "breakouts", "branding"] as const) if (a.grants[k]) out[k] = true;
  }
  return s.custom?.limits ? mergeLimits(out, s.custom.limits) : out;
}

/* --------------------------------- proration ------------------------------- */

/**
 * The proration rule, shown on every screen that changes a plan and applied
 * by subscriptions.ts. eSPees can neither charge a saved wallet nor refund,
 * so no rule here moves money — it moves time.
 */
export const PRORATION_RULE = [
  "eSPees cannot charge or refund automatically. Nothing here moves money: collect or refund off-band, and note it.",
  "Upgrade (the new plan costs more per day): applies now. The unused days of the current period are valued at the price paid and converted into days on the new plan at its price, added to the new period.",
  "Downgrade (costs less per day): applies at the end of the current period by default, with no refund — the account keeps its plan until then. Applied now instead, the unused value converts the same way (more days on the cheaper plan).",
  "Buying the same plan again (a renewal): the new period starts when the current one ends, so no paid days are lost.",
  "Moving to Free, a complimentary plan or a custom arrangement: unused paid days are not converted. Schedule it for the period end to use them up first.",
];

/** Price per day of what the subscription is paying, in ESP; 0 when unknown or free. */
export function dailyPrice(s: Pick<Subscription, "pricePaid" | "snapshot" | "cycle" | "status" | "source"> | null): number {
  if (!s || !s.cycle || s.status === "complimentary" || s.source === "complimentary") return 0;
  const paid = s.pricePaid?.currency === "ESP" ? s.pricePaid.amount : null;
  const amount = paid ?? espPrice(s.snapshot.prices, s.cycle) ?? 0;
  return amount > 0 ? amount / CYCLE_DAYS[s.cycle] : 0;
}

/** Unused time valued at `oldDaily`, re-bought at `newDaily`. Capped at five years. */
export function convertRemaining(remainingMs: number, oldDaily: number, newDaily: number): number {
  if (remainingMs <= 0 || oldDaily <= 0 || newDaily <= 0) return 0;
  return Math.min(Math.round((remainingMs * oldDaily) / newDaily), 5 * 365 * DAY_MS);
}

export function fmtDays(ms: number): string {
  const d = ms / DAY_MS;
  return `${Math.round(d * 10) / 10} day${Math.abs(d - 1) < 0.05 ? "" : "s"}`;
}

// src/lib/finance/reminders.ts
//
// Billing reminder emails, sent by the daily cron /api/cron/billing-reminders:
//
//   failed     a plan payment failed (the eSPees fail route records these)
//   abandoned  a checkout was started and never finished
//   renewal    a paid plan is about to run out
//
// Rules (KV, edited on the admin Billing settings page):
//
//   billing:reminders:rules   ReminderRules — all off until an admin turns them on
//
// Never twice: before sending, the run claims
//
//   billing:reminders:sent:<kind>:<subject>:<step>
//
// with SET NX. Two runs at once, or a rerun of the same day, find the claim
// and skip. A send that fails gives the claim back so the next run retries.
// When several steps are due at once (rules just switched on), only the
// latest is sent and the earlier ones are claimed with it.
//
//   billing:reminders:log     list, newest first, last 500 sends and skips
//
// The wording is the billing.* templates in src/lib/comms/templateDefaults.ts,
// editable in Admin → Email templates; what goes out is the edited version.

import { kv } from "@/lib/kv";
import { isMailConfigured } from "@/lib/mail";
import { renderEmail, sendTemplateEmail } from "@/lib/comms/templates";
import type { TemplateVars } from "@/lib/comms/format";
import { entriesBetween, lookupUser, type LedgerEntry } from "@/lib/finance/ledger";
import { CHECKOUT_WINDOW_MS, checkoutState, listCheckouts, type CheckoutLog } from "@/lib/finance/checkouts";
import { fmtMoney } from "@/lib/finance/money";
import { DAY } from "@/lib/finance/revenue";

const RULES = "billing:reminders:rules";
const LOG = "billing:reminders:log";
const SENT = (key: string) => `billing:reminders:sent:${key}`;
const CLAIM_S = 400 * 24 * 60 * 60;
/** Reminders for things older than this are not sent at all. */
const LOOKBACK = 30 * DAY;

export type ReminderKind = "failed" | "abandoned" | "renewal";

export interface ReminderRules {
  failed: { enabled: boolean; afterDays: number[] };
  abandoned: { enabled: boolean; afterDays: number[] };
  renewal: { enabled: boolean; beforeDays: number[] };
  updatedAt?: number;
  updatedBy?: string;
}

export const DEFAULT_RULES: ReminderRules = {
  failed: { enabled: false, afterDays: [1, 3] },
  abandoned: { enabled: false, afterDays: [1] },
  renewal: { enabled: false, beforeDays: [7, 1] },
};

export async function getReminderRules(): Promise<ReminderRules> {
  const r = (await kv.get<ReminderRules>(RULES)) as Partial<ReminderRules> | null;
  return {
    failed: { ...DEFAULT_RULES.failed, ...(r?.failed ?? {}) },
    abandoned: { ...DEFAULT_RULES.abandoned, ...(r?.abandoned ?? {}) },
    renewal: { ...DEFAULT_RULES.renewal, ...(r?.renewal ?? {}) },
    updatedAt: r?.updatedAt,
    updatedBy: r?.updatedBy,
  };
}

function cleanDays(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v)) return null;
  const days = [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= max))].sort((a, b) => a - b);
  return days.length ? days.slice(0, 5) : null;
}

export function cleanRules(input: unknown): ReminderRules | string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, Record<string, unknown> | undefined>;
  const failedDays = cleanDays(o.failed?.afterDays, 30);
  const abandonedDays = cleanDays(o.abandoned?.afterDays, 30);
  const renewalDays = cleanDays(o.renewal?.beforeDays, 60);
  if (!failedDays || !abandonedDays || !renewalDays) return "Each reminder needs one to five whole numbers of days (0–30 after, 0–60 before).";
  return {
    failed: { enabled: o.failed?.enabled === true, afterDays: failedDays },
    abandoned: { enabled: o.abandoned?.enabled === true, afterDays: abandonedDays },
    renewal: { enabled: o.renewal?.enabled === true, beforeDays: renewalDays },
  };
}

export async function saveReminderRules(r: ReminderRules): Promise<void> {
  await kv.set(RULES, r);
}

export interface ReminderLogEntry {
  at: number;
  kind: ReminderKind;
  key: string;
  userId: string;
  email: string | null;
  outcome: "sent" | "failed" | "skipped";
  detail?: string;
  /** "cron" or the administrator who pressed Run now. */
  by: string;
}

export async function readReminderLog(limit = 100): Promise<ReminderLogEntry[]> {
  const raw = ((await kv.lrange(LOG, 0, Math.max(0, limit - 1))) ?? []) as unknown[];
  return raw
    .map((r) => {
      if (r && typeof r === "object") return r as ReminderLogEntry;
      try {
        return JSON.parse(String(r)) as ReminderLogEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is ReminderLogEntry => !!x);
}

async function log(e: ReminderLogEntry) {
  await kv.lpush(LOG, JSON.stringify(e));
  await kv.ltrim(LOG, 0, 499);
}

/* ------------------------------ planning ------------------------------ */

export interface DueReminder {
  kind: ReminderKind;
  /** The claim key (without prefix): kind:subject:step. */
  key: string;
  /** Earlier steps of the same subject, claimed along with this one. */
  alsoClaims: string[];
  userId: string;
  subject: string;
  step: number;
  amount: number | null;
  currency: string;
  plan: string;
  cycle: string;
  /** When the plan runs out (renewal) or when the payment failed / checkout started. */
  when: number;
}

/** The latest step that is due: `at + days` has passed (after) or `at - days` has (before). */
function dueStep(steps: number[], due: (d: number) => number, now: number, until: number): number[] {
  return steps.filter((d) => due(d) <= now && now < until);
}

export function planReminders(
  rules: ReminderRules,
  entries: LedgerEntry[],
  checkouts: CheckoutLog[],
  now: number,
): DueReminder[] {
  const out: DueReminder[] = [];
  const plans = entries.filter((e) => e.kind === "plan" && e.userId);
  const paidAfter = (userId: string, t: number) => plans.some((e) => e.userId === userId && e.status !== "failed" && e.at > t);

  const push = (base: Omit<DueReminder, "key" | "alsoClaims" | "step">, steps: number[]) => {
    if (!steps.length) return;
    // "after" steps grow later as the number grows; "before" steps as it shrinks.
    const latest = base.kind === "renewal" ? Math.min(...steps) : Math.max(...steps);
    const key = (s: number) => `${base.kind}:${base.subject}:${s}`;
    out.push({ ...base, step: latest, key: key(latest), alsoClaims: steps.filter((s) => s !== latest).map(key) });
  };

  if (rules.failed.enabled) {
    for (const e of plans) {
      if (e.status !== "failed" || now - e.at > LOOKBACK || paidAfter(e.userId!, e.at)) continue;
      const steps = dueStep(rules.failed.afterDays, (d) => e.at + d * DAY, now, e.at + LOOKBACK);
      push({ kind: "failed", subject: e.ref, userId: e.userId!, amount: e.amount, currency: e.currency, plan: e.plan ?? "", cycle: e.cycle ?? "", when: e.at }, steps);
    }
  }
  if (rules.abandoned.enabled) {
    for (const c of checkouts) {
      if (checkoutState(c, now) !== "abandoned" || now - c.createdAt > LOOKBACK || paidAfter(c.userId, c.createdAt)) continue;
      const start = c.createdAt + CHECKOUT_WINDOW_MS;
      const steps = dueStep(rules.abandoned.afterDays, (d) => start + d * DAY, now, c.createdAt + LOOKBACK);
      push({ kind: "abandoned", subject: c.nonce, userId: c.userId, amount: c.amount, currency: c.currency, plan: c.plan, cycle: c.billingCycle, when: c.createdAt }, steps);
    }
  }
  if (rules.renewal.enabled) {
    // Only each user's latest plan payment can come up for renewal.
    const latest = new Map<string, LedgerEntry>();
    for (const e of plans) {
      if (e.status === "failed") continue;
      const cur = latest.get(e.userId!);
      if (!cur || e.at > cur.at) latest.set(e.userId!, e);
    }
    for (const e of latest.values()) {
      if (!e.periodEnd || e.periodEnd <= now || e.status === "refunded" || e.refunds.some((r) => r.downgraded)) continue;
      const steps = dueStep(rules.renewal.beforeDays, (d) => e.periodEnd! - d * DAY, now, e.periodEnd);
      push({ kind: "renewal", subject: e.ref, userId: e.userId!, amount: e.amount, currency: e.currency, plan: e.plan ?? "", cycle: e.cycle ?? "", when: e.periodEnd }, steps);
    }
  }
  return out;
}

/* ------------------------------ emails ------------------------------ */

const PLAN = (p: string) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : "your");

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://www.neoconference.app").replace(/\/+$/, "");
}

/** The editable template (Admin → Email templates) each kind goes out as. */
export const REMINDER_TEMPLATE: Record<ReminderKind, string> = {
  failed: "billing.failed_payment",
  abandoned: "billing.abandoned_checkout",
  renewal: "billing.renewal_reminder",
};

/** The variables a reminder's template is filled with. */
export function reminderVars(r: DueReminder): TemplateVars {
  return {
    plan: PLAN(r.plan),
    amount: r.amount != null ? fmtMoney(r.amount, r.currency) : "",
    currency: r.currency,
    cycle: r.cycle === "annual" ? "annual" : "monthly",
    endDate: r.kind === "renewal" ? new Date(r.when).toUTCString().slice(0, 16) : "",
    pricingUrl: `${appUrl()}/pricing`,
    billingUrl: `${appUrl()}/dashboard/billing`,
  };
}

/* ------------------------------ running ------------------------------ */

export interface RunResult {
  ran: boolean;
  skipped?: "mail_not_configured" | "all_off";
  due: number;
  sent: number;
  failed: number;
  alreadySent: number;
  noEmail: number;
  /** Due, but the caller's filter said not now: left unclaimed for a later run. */
  deferred: number;
  preview?: (DueReminder & { email: string | null; subjectLine: string })[];
}

/**
 * Work out what is due and (unless dryRun) send it. `by` goes in the log.
 * Safe to call any number of times: claims make each reminder go out once.
 */
export interface RunOptions {
  dryRun?: boolean;
  /** Goes in the log: "cron", an administrator's email, "automation:<ruleId>". */
  by?: string;
  /** Use these rules instead of the ones in Billing settings (an automation rule's own days). */
  rules?: ReminderRules;
  /** Only these kinds. */
  kinds?: ReminderKind[];
  /** Asked for each due reminder before it is claimed; false leaves it unclaimed for a later run. */
  filter?: (r: DueReminder) => boolean;
}

export async function runReminders(now: number, opts: RunOptions = {}): Promise<RunResult> {
  const base = opts.rules ?? (await getReminderRules());
  const only = (k: ReminderKind) => !opts.kinds || opts.kinds.includes(k);
  const rules: ReminderRules = {
    failed: { ...base.failed, enabled: base.failed.enabled && only("failed") },
    abandoned: { ...base.abandoned, enabled: base.abandoned.enabled && only("abandoned") },
    renewal: { ...base.renewal, enabled: base.renewal.enabled && only("renewal") },
  };
  const by = opts.by ?? "cron";
  if (!rules.failed.enabled && !rules.abandoned.enabled && !rules.renewal.enabled) {
    return { ran: false, skipped: "all_off", due: 0, sent: 0, failed: 0, alreadySent: 0, noEmail: 0, deferred: 0 };
  }
  // Renewals look ahead up to 60 days; their payments started a year before.
  const entries = await entriesBetween(now - 400 * DAY, now);
  const checkouts = await listCheckouts(now - LOOKBACK - DAY, now);
  const due = planReminders(rules, entries, checkouts, now);
  const result: RunResult = { ran: true, due: due.length, sent: 0, failed: 0, alreadySent: 0, noEmail: 0, deferred: 0 };

  if (opts.dryRun) {
    result.preview = [];
    for (const r of due) {
      if (await kv.get(SENT(r.key))) {
        result.alreadySent++;
        continue;
      }
      if (opts.filter && !opts.filter(r)) {
        result.deferred++;
        continue;
      }
      const who = await lookupUser(r.userId);
      result.preview.push({ ...r, email: who.email, subjectLine: (await renderEmail(REMINDER_TEMPLATE[r.kind], reminderVars(r))).subject });
    }
    return result;
  }
  if (!isMailConfigured()) {
    // Claim nothing: once mail is set up, the next run sends what is due.
    return { ...result, ran: false, skipped: "mail_not_configured" };
  }

  for (const r of due) {
    if (opts.filter && !opts.filter(r)) {
      result.deferred++;
      continue;
    }
    const claimed = (await kv.set(SENT(r.key), { at: now, by }, { nx: true, ex: CLAIM_S })) !== null;
    if (!claimed) {
      result.alreadySent++;
      continue;
    }
    const who = await lookupUser(r.userId);
    if (!who.email) {
      result.noEmail++;
      await log({ at: now, kind: r.kind, key: r.key, userId: r.userId, email: null, outcome: "skipped", detail: "No email address on the account.", by });
      continue;
    }
    const sent = await sendTemplateEmail(REMINDER_TEMPLATE[r.kind], reminderVars(r), { to: who.email });
    if (sent.ok) {
      result.sent++;
      for (const k of r.alsoClaims) await kv.set(SENT(k), { at: now, by, with: r.key }, { nx: true, ex: CLAIM_S });
      await log({ at: now, kind: r.kind, key: r.key, userId: r.userId, email: who.email, outcome: "sent", detail: sent.rendered.subject, by });
    } else {
      result.failed++;
      // Give the claim back so the next run tries again.
      await kv.del(SENT(r.key));
      await log({ at: now, kind: r.kind, key: r.key, userId: r.userId, email: who.email, outcome: "failed", detail: sent.error.slice(0, 200), by });
    }
  }
  return result;
}

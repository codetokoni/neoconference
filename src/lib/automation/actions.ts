// src/lib/automation/actions.ts
//
// What each kind of rule does, by calling the code that already does it:
//
//   reminder       trial ending → the "reminder.trial" email template + the bell
//                  renewal due / payment failed → billing reminders (src/lib/finance/reminders.ts)
//                  meeting cap / recording hours → usage reminders (src/lib/comms/reminders.ts)
//   announcement   the announcement queue (src/lib/comms/sends.ts)
//   subscriptions  the downgrade-expired-plans job (subscriptions sweepDue + Clerk), via the job registry
//   report         analytics (src/lib/admin/analytics.ts) as CSV, by the "automation.report" template
//   maintenance    registered jobs that are safe to run again (src/lib/ops/jobRegistry.ts)
//   purge          retention targets (none yet: data governance adds them)
//
// Each action first *plans*: the subjects it would act on now, each with an
// idempotency key that names the subject and the period ("trial of user X
// ending on D, 3-day notice"). The engine (src/lib/automation/runner.ts)
// filters that list — already done, cooling down, over the per-run maximum —
// and a dry run stops there. Then it performs.

import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import type { Rule } from "@/lib/automation/model";
import { previousRun } from "@/lib/automation/schedule";
import { addNotification } from "@/lib/notificationStore";
import { getPlanLimitsForUserId } from "@/lib/plan";
import { limitsFromMetadata } from "@/lib/planLimits";
import { effectivePlan, type ClerkUserish } from "@/lib/admin/users";
import { usageMonth, recordedSeconds } from "@/lib/recordingUsage";
import { ownerEmails } from "@/lib/admin/owner";
import { listByPeriodEnd, planDue } from "@/lib/billing/subscriptions";
import { runReminders, type ReminderRules } from "@/lib/finance/reminders";
import { meetingCapReminder, recordingReminder } from "@/lib/comms/reminders";
import { sendTemplateEmail } from "@/lib/comms/templates";
import { cleanAudience, describeAudience, previewAudience } from "@/lib/comms/audience";
import { confirmSend, createDraft, processSend } from "@/lib/comms/sends";
import { buildAnalytics, analyticsTables, type ReportName } from "@/lib/admin/analytics";
import { csvOf } from "@/lib/admin/exportReport";
import { addDays, dayInZone, period } from "@/lib/activityReports";
import { jobDef, JOBS, runRegisteredJob } from "@/lib/ops/jobRegistry";
import { opsRecipients } from "@/lib/ops/notify";
import { PURGE_TARGETS } from "@/lib/automation/purgeTargets";

export { PURGE_TARGETS };

const DAY = 24 * 60 * 60 * 1000;

export interface Target {
  /** Idempotency key: subject + period. */
  key: string;
  label: string;
  userId?: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface ActionContext {
  rule: Rule;
  now: number;
  /** The scheduled time this run belongs to. */
  slot: number | null;
  runId: string;
  /** "automation:<ruleId>" — who the other systems record as having done it. */
  actor: string;
}

export type Performed = { outcome: "done"; detail?: string } | { outcome: "already"; detail?: string } | { outcome: "skipped"; detail: string };

export interface BatchResult {
  done: number;
  already: number;
  skipped: number;
  failed: number;
  errors: { target: string; message: string }[];
  summary?: string;
}

export interface Plan {
  targets: Target[];
  /** People one run can reach, when that is not one per target (an announcement's audience). */
  recipients?: number;
  note?: string;
}

export interface ActionImpl {
  /**
   * True: the engine claims each target's key before acting, so a double run
   * or a retry does it once. False: the target is already claimed by what is
   * called (billing and usage reminders keep their own claims) or is safe to
   * repeat (a job registered as retry-safe).
   */
  claims: boolean;
  plan(ctx: ActionContext): Promise<Plan>;
  perform?(ctx: ActionContext, t: Target): Promise<Performed>;
  /** Acts on all the allowed targets at once. */
  batch?(ctx: ActionContext, targets: Target[]): Promise<BatchResult>;
}

function site(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://www.neoconference.app").replace(/\/+$/, "");
}

/** The period a once-per-period action belongs to: this run's slot, or the latest scheduled time. */
function periodOf(ctx: ActionContext): string {
  const slot = ctx.slot ?? previousRun(ctx.rule.schedule, ctx.rule.timezone, ctx.now);
  return slot == null ? `day:${new Date(ctx.now).toISOString().slice(0, 10)}` : new Date(slot).toISOString();
}

/* ------------------------------ reminders ------------------------------- */

type ClerkUser = ClerkUserish;

/** Every account, a page at a time, up to `cap`. */
async function allUsers(cap = 10_000): Promise<ClerkUser[]> {
  const client = await clerkClient();
  const out: ClerkUser[] = [];
  for (let offset = 0; offset < cap; ) {
    const page = (await client.users.getUserList({ limit: 500, offset })) as { data: ClerkUser[]; totalCount: number };
    out.push(...page.data);
    offset += page.data.length;
    if (!page.data.length || offset >= page.totalCount) break;
  }
  return out;
}

const emailOf = (u: ClerkUser) => (u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || "").toLowerCase();
const planName = (p: string) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : "");

function billingRules(kind: "renewal" | "failed", days: number[]): ReminderRules {
  return {
    failed: { enabled: kind === "failed", afterDays: kind === "failed" ? [...days].sort((a, b) => a - b) : [1] },
    abandoned: { enabled: false, afterDays: [1] },
    renewal: { enabled: kind === "renewal", beforeDays: kind === "renewal" ? [...days].sort((a, b) => a - b) : [7] },
  };
}

const reminder: ActionImpl = {
  claims: true,
  async plan(ctx) {
    const c = ctx.rule.condition!;
    switch (c.kind) {
      case "trial_ends_in": {
        const longest = Math.max(...c.days!);
        const subs = await listByPeriodEnd(ctx.now, ctx.now + longest * DAY + 1);
        const targets: Target[] = [];
        for (const s of subs) {
          if (s.status !== "trialing" || s.periodEnd == null || s.periodEnd <= ctx.now) continue;
          // The latest notice due: of 7 / 3 / 1 days, the smallest whose time has come.
          const due = c.days!.filter((d) => s.periodEnd! - d * DAY <= ctx.now);
          if (!due.length) continue;
          const step = Math.min(...due);
          const left = Math.max(0, Math.ceil((s.periodEnd - ctx.now) / DAY));
          targets.push({
            key: `trial:${s.userId}:${s.periodEnd}:${step}`,
            label: s.email || s.userId,
            userId: s.userId,
            detail: `Trial of ${s.snapshot?.name ?? planName(s.baseTier)} ends ${new Date(s.periodEnd).toISOString().slice(0, 10)} (${step}-day notice)`,
            data: { email: s.email, plan: s.snapshot?.name ?? planName(s.baseTier), periodEnd: s.periodEnd, days: left },
          });
        }
        return { targets };
      }
      case "renewal_due":
      case "payment_failed": {
        const kind = c.kind === "renewal_due" ? "renewal" : "failed";
        const r = await runReminders(ctx.now, { dryRun: true, rules: billingRules(kind, c.days!), kinds: [kind], by: ctx.actor });
        const targets = (r.preview ?? []).map((p) => ({
          key: `billing:${p.key}`,
          label: p.email ?? p.userId,
          userId: p.userId,
          detail: p.subjectLine,
        }));
        return { targets, note: r.alreadySent ? `${r.alreadySent} already sent by billing reminders` : undefined };
      }
      case "meeting_cap": {
        const targets: Target[] = [];
        for (const u of await allUsers()) {
          // The owner and ADMIN_EMAILS accounts are never capped (effectivePlan → enterprise).
          const plan = effectivePlan(u);
          if (plan !== "free") continue;
          const cap = limitsFromMetadata(u.publicMetadata).lifetimeMeetingCap;
          if (cap <= 0) continue;
          const used = Number(u.publicMetadata?.meetingsCreated ?? 0) || 0;
          const pct = Math.round((used / cap) * 100);
          if (pct < c.pct!) continue;
          targets.push({
            key: `meetings:${u.id}:${c.pct}`,
            label: emailOf(u) || u.id,
            userId: u.id,
            detail: `${used} of ${cap} meetings (${pct}%)`,
            data: { used, cap, plan },
          });
        }
        return { targets };
      }
      case "recording_hours": {
        const month = usageMonth(ctx.now);
        const targets: Target[] = [];
        let cursor: string | number = 0;
        const owners: string[] = [];
        do {
          const [next, keys] = (await kv.scan(cursor, { match: "neo:rec-usage:*", count: 1000 })) as [string | number, string[]];
          owners.push(...keys.map((k) => k.slice("neo:rec-usage:".length)));
          cursor = next;
        } while (String(cursor) !== "0" && owners.length < 20_000);
        for (const uid of owners) {
          const used = await recordedSeconds(uid, month);
          if (!used) continue;
          const capHours = (await getPlanLimitsForUserId(uid)).limits.recordingHoursPerMonth;
          if (capHours <= 0) continue;
          const pct = Math.round((used / (capHours * 3600)) * 100);
          if (pct < c.pct!) continue;
          targets.push({
            key: `recording:${uid}:${month}:${c.pct}`,
            label: uid,
            userId: uid,
            detail: `${(used / 3600).toFixed(1)} of ${capHours} h in ${month} (${pct}%)`,
          });
        }
        return { targets };
      }
    }
  },
  async perform(ctx, t) {
    const c = ctx.rule.condition!;
    const ch = ctx.rule.action.channels ?? { email: true, inApp: true };
    const usageRule = { enabled: true, thresholds: [c.pct ?? 100], channels: { email: ch.email, inApp: ch.inApp } };
    if (c.kind === "meeting_cap") {
      const d = t.data as { used: number; cap: number; plan: string };
      return usageOutcome(await meetingCapReminder(t.userId!, d.used, d.cap, d.plan, { rule: usageRule }));
    }
    if (c.kind === "recording_hours") return usageOutcome(await recordingReminder(t.userId!, ctx.now, { rule: usageRule }));
    // trial_ends_in
    const d = t.data as { email: string; plan: string; periodEnd: number; days: number };
    const vars = {
      name: "",
      planName: d.plan,
      days: d.days,
      endsOn: new Date(d.periodEnd).toUTCString().slice(0, 16),
      origin: site(),
    };
    let reached = 0;
    if (ch.inApp) {
      await addNotification(t.userId!, { type: "reminder", title: `Your ${d.plan} trial ends in ${d.days} day${d.days === 1 ? "" : "s"}`, body: "Choose a plan to keep its features.", url: "/pricing" });
      reached++;
    }
    if (ch.email) {
      if (!d.email) return reached ? { outcome: "done", detail: "bell only: no email address" } : { outcome: "skipped", detail: "No email address on the account." };
      const r = await sendTemplateEmail("reminder.trial", vars, { to: d.email });
      if (!r.ok) throw new Error(`email not sent: ${r.error}`);
      reached++;
    }
    return { outcome: "done" };
  },
};

/** Usage reminders answer with a word; map it to the engine's outcome. */
function usageOutcome(r: string): Performed {
  if (r.startsWith("sent")) return { outcome: "done", detail: r };
  if (r === "already_sent") return { outcome: "already" };
  if (r === "error") throw new Error("usage reminder failed (see server log)");
  return { outcome: "skipped", detail: r };
}

/** Renewal and failed-payment reminders are claimed by billing itself: one batch call, filtered to what the engine allowed. */
const billingReminder: ActionImpl = {
  claims: false,
  plan: reminder.plan,
  async batch(ctx, targets) {
    const c = ctx.rule.condition!;
    const kind = c.kind === "renewal_due" ? "renewal" : "failed";
    const allowed = new Set(targets.map((t) => t.key));
    const r = await runReminders(ctx.now, {
      rules: billingRules(kind, c.days!),
      kinds: [kind],
      by: ctx.actor,
      filter: (d) => allowed.has(`billing:${d.key}`),
    });
    if (r.skipped === "mail_not_configured") throw new Error("Email is not set up (RESEND_API_KEY), so no reminder could be sent.");
    return {
      done: r.sent,
      already: r.alreadySent,
      skipped: r.noEmail,
      failed: r.failed,
      errors: r.failed ? [{ target: "billing reminders", message: `${r.failed} email(s) failed; see Billing → Reminders log` }] : [],
    };
  },
};

/* ----------------------------- announcement ----------------------------- */

const announcement: ActionImpl = {
  claims: true,
  async plan(ctx) {
    const a = ctx.rule.action;
    const aud = cleanAudience(a.audience);
    if ("error" in aud) throw new Error(aud.error);
    const preview = await previewAudience(aud.audience);
    return {
      targets: [
        {
          key: `announce:${periodOf(ctx)}`,
          label: `"${a.message!.title}" to ${describeAudience(aud.audience)}`,
          detail: `${preview.exact ? "" : "about "}${preview.count} recipient${preview.count === 1 ? "" : "s"}`,
        },
      ],
      recipients: preview.count,
    };
  },
  async perform(ctx) {
    const a = ctx.rule.action;
    const aud = cleanAudience(a.audience);
    if ("error" in aud) throw new Error(aud.error);
    const actor = { userId: ctx.actor, email: "automation" };
    const { send } = await createDraft(
      {
        kind: a.sendKind ?? "announcement",
        message: a.message!,
        channels: { email: !!a.channels?.email, inApp: !!a.channels?.inApp, push: !!a.channels?.push },
        audience: aud.audience,
        startsAt: null,
        endsAt: null,
      },
      actor,
      site(),
    );
    const queued = await confirmSend(send, actor);
    // Start delivering now (awaited: Vercel drops unawaited work); the send queue's own tick finishes the rest.
    const p = await processSend(queued.id, 8_000);
    return { outcome: "done", detail: `queued as ${queued.id} for ${queued.preview.count} recipient(s); ${p.status}` };
  },
};

/* --------------------------------- report --------------------------------- */

async function reportRecipients(to: "owner" | "owner_and_ops"): Promise<string[]> {
  const set = new Set(ownerEmails());
  if (to === "owner_and_ops") for (const r of await opsRecipients()) set.add(r.email);
  return [...set];
}

const report: ActionImpl = {
  claims: true,
  async plan(ctx) {
    const rep = ctx.rule.action.report!;
    const to = await reportRecipients(rep.to);
    return {
      targets: [{ key: `report:${periodOf(ctx)}`, label: `${rep.days}-day report (${rep.tables.join(", ")})`, detail: `to ${to.join(", ") || "nobody"}` }],
      recipients: to.length,
    };
  },
  async perform(ctx) {
    const rep = ctx.rule.action.report!;
    const tz = ctx.rule.timezone;
    const last = addDays(dayInZone(ctx.now, tz), -1);
    const first = addDays(last, -(rep.days - 1));
    const p = period(first, last, tz);
    const analytics = await buildAnalytics(p, { now: ctx.now });
    const tables = analyticsTables(analytics);
    const to = await reportRecipients(rep.to);
    if (!to.length) return { outcome: "skipped", detail: "No owner address (PLATFORM_OWNER_EMAILS)." };
    const summary = tables.summary.rows.map((r) => tables.summary.columns.map((col) => String(r[col.key] ?? "")).join(": ")).join("\n");
    const res = await sendTemplateEmail(
      "automation.report",
      { reportName: ctx.rule.name, period: `${first} to ${last} (${tz})`, summary, origin: site() },
      {
        to: to[0],
        bcc: to.slice(1),
        attachments: rep.tables.map((name) => ({
          filename: `neoconference-${name}-${first}-to-${last}.csv`,
          content: csvOf(tables[name as ReportName]),
          contentType: "text/csv",
        })),
      },
    );
    if (!res.ok) throw new Error(`report email not sent: ${res.error}`);
    return { outcome: "done", detail: `sent to ${to.length} address(es)` };
  },
};

/* ------------------------- subscriptions and jobs ------------------------- */

export const SUBSCRIPTION_JOB = "downgrade-expired-plans";

const subscriptions: ActionImpl = {
  claims: false,
  async plan(ctx) {
    // The same decision the sweep makes (planDue), so the preview cannot drift from the run.
    const targets = (await planDue(ctx.now)).map((d) => ({
      key: `sub:${d.userId}:${d.action}`,
      label: d.email || d.userId,
      userId: d.userId,
      detail: d.summary,
    }));
    return { targets, note: "Also moves any account whose paid period has ended back to Free in Clerk." };
  },
  async batch(ctx, targets) {
    const r = await runRegisteredJob(SUBSCRIPTION_JOB, { trigger: "automation", actor: ctx.actor });
    if (r.locked) throw new Error("The subscription sweep is already running; this run did nothing.");
    if (!r.run || r.run.outcome === "failed" || r.run.outcome === "abandoned") throw new Error(r.run?.error || `sweep failed (HTTP ${r.status})`);
    return { done: targets.length, already: 0, skipped: 0, failed: 0, errors: [], summary: r.run.summary };
  },
};

/** Registered jobs a maintenance rule may run: those safe to run again, other than the automation dispatcher. */
export function maintenanceJobs(): { name: string; label: string }[] {
  return JOBS.filter((j) => j.retrySafe && j.name !== "automation-dispatch").map((j) => ({ name: j.name, label: j.label }));
}

/** Crons a rule may take over: registered jobs with a schedule. */
export function replaceableJobs(): { name: string; label: string; schedule: string | null }[] {
  return JOBS.filter((j) => j.schedule && j.name !== "automation-dispatch").map((j) => ({ name: j.name, label: j.label, schedule: j.schedule }));
}

const maintenance: ActionImpl = {
  claims: false,
  async plan(ctx) {
    return {
      targets: (ctx.rule.action.jobs ?? []).map((name) => ({ key: `job:${name}`, label: jobDef(name)?.label ?? name, detail: jobDef(name)?.description })),
    };
  },
  async perform(ctx, t) {
    const name = t.key.slice("job:".length);
    const r = await runRegisteredJob(name, { trigger: "automation", actor: ctx.actor });
    if (r.locked) return { outcome: "skipped", detail: "already running" };
    if (!r.run || r.run.outcome === "failed" || r.run.outcome === "abandoned") throw new Error(r.run?.error || `HTTP ${r.status}`);
    return { outcome: "done", detail: r.run.summary };
  },
};

/* --------------------------------- purge --------------------------------- */


const purge: ActionImpl = {
  claims: true,
  async plan(ctx) {
    const target = PURGE_TARGETS.find((p) => p.id === ctx.rule.action.target);
    if (!target) throw new Error(`No retention target "${ctx.rule.action.target}".`);
    return { targets: await target.plan(ctx.now, ctx.rule.options.maxPerRun + 1) };
  },
  async perform(ctx, t) {
    const target = PURGE_TARGETS.find((p) => p.id === ctx.rule.action.target)!;
    return target.purge(t, ctx.actor);
  },
};

export function actionFor(rule: Rule): ActionImpl {
  switch (rule.action.kind) {
    case "reminder":
      return rule.condition?.kind === "renewal_due" || rule.condition?.kind === "payment_failed" ? billingReminder : reminder;
    case "announcement":
      return announcement;
    case "report":
      return report;
    case "subscriptions":
      return subscriptions;
    case "maintenance":
      return maintenance;
    case "purge":
      return purge;
  }
}

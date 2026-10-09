// src/lib/automation/runner.ts
//
// Running rules. One dispatcher cron (/api/cron/automation, every 5 minutes)
// calls runDueRules(); "Run now" and "Preview" on /admin/automation call
// runRule(). Every real run goes through the job runner (src/lib/ops/jobs.ts)
// as job "automation:<ruleId>", which gives:
//
//   - a lock per rule: a second run while one is going does nothing;
//   - the run history (start, end, outcome, who) that the Jobs page shows too.
//
// On top of that, each subject a rule acts on carries an idempotency key
// naming the subject and its period, claimed (SET NX) before acting and
// handed back if the action fails: a rule that runs twice, or a run retried
// after it died half-way, reaches each person once per period.
//
// A rule that fails `failureThreshold` times in a row is marked failing and
// raises an ops alert to the owner and the ops admins; its next good run
// clears both.
//
// A rule that replaces a cron keeps that cron quiet while the rule is active:
// the dispatcher writes neo:ops:job:replaced:<job> with a short TTL on every
// tick, and the cron route (cronRoute in src/lib/ops/cron.ts) skips its
// scheduled run while the key is there. If the dispatcher stops, the key
// expires and the cron runs again — the job is never left with nobody.

import { kv } from "@/lib/kv";
import { localParts } from "@/lib/zonedTime";
import { nextRun, wallToInstant } from "@/lib/automation/schedule";
import { inQuietHours, sendsToPeople, type Rule } from "@/lib/automation/model";
import { actionFor, type ActionContext, type Target } from "@/lib/automation/actions";
import {
  claim,
  getRunDetail,
  getState,
  isClaimed,
  isCooling,
  listRules,
  release,
  saveRunDetail,
  saveState,
  startCooldown,
  zeroCounts,
  type RunDetail,
  type RunItem,
  type RuleState,
} from "@/lib/automation/store";
import { ensureBuiltIns } from "@/lib/automation/builtins";
import { jobReplacedKey, listRuns, runJob, type JobRun, type JobTrigger } from "@/lib/ops/jobs";
import { raiseAlert, resolveAlertFor } from "@/lib/ops/alerts";

export const jobName = (ruleId: string) => `automation:${ruleId}`;
export const DISPATCH_JOB = "automation-dispatch";
/** How long a replaced cron stays quiet without a dispatcher tick. Six ticks. */
export const REPLACED_TTL_S = 30 * 60;
const ITEMS_KEPT = 200;

export interface RunOptions {
  now?: number;
  /** "schedule": the dispatcher; "manual": Run now; "retry". */
  trigger: "schedule" | "manual" | "retry";
  /** Who started it: an administrator's email, or "automation-dispatch". */
  by: string;
  /** The scheduled time this run belongs to. */
  slot?: number | null;
  dryRun?: boolean;
}

export interface RunResult {
  status: "ran" | "locked" | "preview";
  detail: RunDetail;
  run?: JobRun;
  ok: boolean;
  error?: string;
}

function clip(s: string, n = 300): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const message = (e: unknown) => clip(e instanceof Error ? e.message || e.name : String(e));

function summarise(d: RunDetail): string {
  const c = d.counts;
  const parts = [`${c.done} done`];
  if (c.already) parts.push(`${c.already} already done`);
  if (c.cooling) parts.push(`${c.cooling} in cooldown`);
  if (c.deferred) parts.push(`${c.deferred} left for the next run`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.failed) parts.push(`${c.failed} failed`);
  return `${c.targets} found: ${parts.join(", ")}${d.note ? ` (${d.note})` : ""}`;
}

/**
 * Work out (and unless dryRun, do) what the rule does now. The body of the
 * job; never throws — a failure is in the detail.
 */
async function execute(rule: Rule, ctx: ActionContext, dryRun: boolean): Promise<{ detail: RunDetail; fatal?: string }> {
  const detail: RunDetail = { runId: ctx.runId, ruleId: rule.id, ruleVersion: rule.version, slot: ctx.slot, dryRun, counts: zeroCounts(), errors: [], items: [] };
  const item = (t: Target, outcome: RunItem["outcome"], d?: string) => {
    if (detail.items.length < ITEMS_KEPT) detail.items.push({ key: t.key, label: t.label, outcome, ...(d ?? t.detail ? { detail: d ?? t.detail } : {}) });
  };
  const impl = actionFor(rule);
  let targets: Target[];
  try {
    const plan = await impl.plan(ctx);
    targets = plan.targets;
    if (plan.note) detail.note = plan.note;
  } catch (e) {
    detail.errors.push({ target: "finding what to do", message: message(e) });
    return { detail, fatal: `Could not work out what to do: ${message(e)}` };
  }
  detail.counts.targets = targets.length;

  const allowed: Target[] = [];
  const max = rule.options.maxPerRun;
  const people = sendsToPeople(rule.action);
  for (const t of targets) {
    if (impl.claims && (await isClaimed(rule.id, t.key))) {
      detail.counts.already++;
      item(t, "already");
    } else if (people && t.userId && rule.options.cooldownHours > 0 && (await isCooling(rule.id, t.userId))) {
      detail.counts.cooling++;
      item(t, "cooling");
    } else if (allowed.length >= max) {
      detail.counts.deferred++;
      item(t, "deferred");
    } else {
      allowed.push(t);
    }
  }
  if (dryRun) {
    for (const t of allowed) item(t, "would_do");
    return { detail };
  }

  if (impl.batch) {
    try {
      const r = await impl.batch(ctx, allowed);
      detail.counts.done += r.done;
      detail.counts.already += r.already;
      detail.counts.skipped += r.skipped;
      detail.counts.failed += r.failed;
      detail.errors.push(...r.errors);
      if (r.summary) detail.note = clip(r.summary, 300);
      for (const t of allowed) item(t, r.failed && !r.done ? "failed" : "done");
      if (people && rule.options.cooldownHours > 0 && r.done) for (const t of allowed) if (t.userId) await startCooldown(rule.id, t.userId, rule.options.cooldownHours);
    } catch (e) {
      detail.counts.failed += allowed.length || 1;
      detail.errors.push({ target: "all", message: message(e) });
      for (const t of allowed) item(t, "failed", message(e));
      return { detail, fatal: message(e) };
    }
    return { detail };
  }

  for (const t of allowed) {
    if (impl.claims && !(await claim(rule.id, t.key, ctx.runId))) {
      // Another run got there between the check and now.
      detail.counts.already++;
      item(t, "already");
      continue;
    }
    try {
      const r = await impl.perform!(ctx, t);
      if (r.outcome === "done") {
        detail.counts.done++;
        item(t, "done", r.detail);
        if (people && t.userId) await startCooldown(rule.id, t.userId, rule.options.cooldownHours);
      } else if (r.outcome === "already") {
        detail.counts.already++;
        item(t, "already", r.detail);
      } else {
        detail.counts.skipped++;
        item(t, "skipped", r.detail);
        // Nothing was done: let a later run try (an email address added, a preference changed).
        if (impl.claims) await release(rule.id, t.key, ctx.runId);
      }
    } catch (e) {
      if (impl.claims) await release(rule.id, t.key, ctx.runId);
      detail.counts.failed++;
      detail.errors.push({ target: t.label, message: message(e) });
      item(t, "failed", message(e));
    }
  }
  return { detail };
}

/** A run failed when it could not start, or when everything it tried failed. */
function runFailed(detail: RunDetail, fatal?: string): boolean {
  return !!fatal || (detail.counts.failed > 0 && detail.counts.done === 0);
}

/** Run one rule now (or preview it). Updates the rule's state; raises or clears the failure alert. */
export async function runRule(rule: Rule, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? Date.now();
  const slot = opts.slot ?? null;
  const actor = jobName(rule.id);

  if (opts.dryRun) {
    const ctx: ActionContext = { rule, now, slot, runId: `preview_${now.toString(36)}`, actor };
    const { detail, fatal } = await execute(rule, ctx, true);
    return { status: "preview", detail, ok: !fatal, error: fatal };
  }

  let detail: RunDetail | null = null;
  let fatal: string | undefined;
  const trigger: JobTrigger = opts.trigger === "schedule" ? "automation" : opts.trigger;
  const result = await runJob(
    jobName(rule.id),
    async (run) => {
      const ctx: ActionContext = { rule, now, slot, runId: run.id, actor };
      const r = await execute(rule, ctx, false);
      detail = r.detail;
      fatal = r.fatal;
      await saveRunDetail(r.detail);
      const failed = runFailed(r.detail, r.fatal);
      return {
        ok: !failed,
        summary: summarise(r.detail),
        error: failed ? r.fatal ?? r.detail.errors.map((e) => `${e.target}: ${e.message}`).join("; ") : undefined,
      };
    },
    { trigger, actor: opts.by },
  );

  const state = await getState(rule.id);
  if (result.status === "locked") {
    const d: RunDetail = { runId: "", ruleId: rule.id, ruleVersion: rule.version, slot, dryRun: false, counts: zeroCounts(), errors: [], items: [], note: "Another run of this rule was in progress; this one did nothing." };
    await saveState(rule.id, { ...state, lastOutcome: "locked", lastSummary: d.note! });
    return { status: "locked", detail: d, ok: false, error: d.note };
  }

  const run = result.run;
  const done = (detail ?? { runId: run.id, ruleId: rule.id, ruleVersion: rule.version, slot, dryRun: false, counts: zeroCounts(), errors: [], items: [] }) as RunDetail;
  if (result.error !== undefined && !fatal) fatal = message(result.error);
  const failed = run.outcome === "failed";
  const next: RuleState = {
    ...state,
    lastRunAt: run.startedAt,
    lastRunId: run.id,
    lastOutcome: failed ? "failed" : run.outcome === "skipped" ? "skipped" : "ok",
    lastSummary: run.summary ?? summarise(done),
    lastError: failed ? run.error ?? fatal ?? "failed" : null,
    failureStreak: failed ? state.failureStreak + 1 : 0,
  };
  if (failed && !state.failing && next.failureStreak >= rule.options.failureThreshold) {
    next.failing = true;
    next.failingSince = now;
    await raiseAlert({
      source: "automation",
      subject: rule.id,
      title: `Automation rule "${rule.name}" is failing`,
      message: `"${rule.name}" failed ${next.failureStreak} time${next.failureStreak === 1 ? "" : "s"} in a row. Last error: ${next.lastError}`,
      url: `/admin/automation?rule=${encodeURIComponent(rule.id)}`,
    });
  } else if (!failed && state.failing) {
    next.failing = false;
    next.failingSince = null;
    await resolveAlertFor("automation", rule.id, "automation", "The rule ran successfully again.");
  }
  await saveState(rule.id, next);
  return { status: "ran", detail: done, run, ok: !failed, error: failed ? next.lastError ?? undefined : undefined };
}

/* ------------------------------- dispatcher ------------------------------- */

/** End of the quiet hours that `at` falls in, on the rule's wall clock. */
function quietEnd(rule: Rule, at: number): number {
  const q = rule.options.quietHours!;
  const [h, mi] = q.end.split(":").map(Number);
  const p = localParts(at, rule.timezone);
  let t = wallToInstant(p.y, p.m, p.d, h, mi, rule.timezone);
  if (t <= at) t = wallToInstant(p.y, p.m, p.d + 1, h, mi, rule.timezone);
  return t;
}

/** Keep the crons that active rules replace quiet (and hand paused rules' crons back). */
export async function syncReplacements(rules: Rule[]): Promise<void> {
  for (const r of rules) {
    if (!r.replaces) continue;
    const key = jobReplacedKey(r.replaces);
    if (r.status === "active") {
      await kv.set(key, JSON.stringify({ ruleId: r.id, ruleName: r.name }), { ex: REPLACED_TTL_S });
    } else {
      const cur = await kv.get(key);
      const holder = cur == null ? null : typeof cur === "string" ? (JSON.parse(cur) as { ruleId?: string }) : (cur as { ruleId?: string });
      if (holder?.ruleId === r.id) await kv.del(key);
    }
  }
}

/** When a rule (newly created, edited or resumed) runs next, from `now`. */
export async function reschedule(rule: Rule, now = Date.now()): Promise<RuleState> {
  const state = await getState(rule.id);
  const next: RuleState = { ...state, nextRunAt: rule.status === "active" ? nextRun(rule.schedule, rule.timezone, now) : null, heldSlot: null };
  await saveState(rule.id, next);
  return next;
}

export interface DispatchSummary {
  rules: number;
  due: number;
  ran: number;
  failed: number;
  locked: number;
  held: number;
  results: { ruleId: string; outcome: string; summary?: string }[];
}

/** Run every active rule whose time has come. The dispatcher cron's body. */
export async function runDueRules(now = Date.now()): Promise<DispatchSummary> {
  await ensureBuiltIns(now);
  const rules = await listRules();
  await syncReplacements(rules);
  const sum: DispatchSummary = { rules: rules.length, due: 0, ran: 0, failed: 0, locked: 0, held: 0, results: [] };
  for (const rule of rules) {
    if (rule.status !== "active") continue;
    const state = await getState(rule.id);
    if (state.nextRunAt == null) {
      // Never scheduled (seeded or restored): start from now, without a run.
      await saveState(rule.id, { ...state, nextRunAt: nextRun(rule.schedule, rule.timezone, now) });
      continue;
    }
    if (state.nextRunAt > now) continue;
    sum.due++;
    const slot = state.heldSlot ?? state.nextRunAt;
    if (sendsToPeople(rule.action) && inQuietHours(rule.options.quietHours, localParts(now, rule.timezone))) {
      await saveState(rule.id, { ...state, heldSlot: slot, nextRunAt: quietEnd(rule, now) });
      sum.held++;
      sum.results.push({ ruleId: rule.id, outcome: "held", summary: "quiet hours" });
      continue;
    }
    let r: RunResult;
    try {
      r = await runRule(rule, { now, trigger: "schedule", by: DISPATCH_JOB, slot });
    } catch (e) {
      sum.failed++;
      sum.results.push({ ruleId: rule.id, outcome: "error", summary: message(e) });
      continue;
    }
    if (r.status === "locked") {
      // The rule is running (Run now, or a slow earlier run): try again next tick.
      sum.locked++;
      sum.results.push({ ruleId: rule.id, outcome: "locked" });
      continue;
    }
    // After the run, from the later of now and the slot: a dispatcher that was
    // down for a day runs a missed rule once, not once per missed slot.
    const after = await getState(rule.id);
    await saveState(rule.id, { ...after, heldSlot: null, nextRunAt: nextRun(rule.schedule, rule.timezone, Math.max(now, slot)) });
    sum.ran++;
    if (!r.ok) sum.failed++;
    sum.results.push({ ruleId: rule.id, outcome: r.ok ? "ok" : "failed", summary: r.run?.summary ?? r.error });
  }
  return sum;
}

/** A rule's run history: the job runner's runs, with this phase's detail. */
export async function ruleHistory(ruleId: string, limit = 30): Promise<(JobRun & { detail: RunDetail | null })[]> {
  const runs = await listRuns(jobName(ruleId), limit);
  return Promise.all(runs.map(async (r) => ({ ...r, detail: await getRunDetail(r.id) })));
}

/** The status shown on the list. */
export function ruleStatus(rule: Rule, state: RuleState): "active" | "paused" | "failing" {
  if (rule.status === "paused") return "paused";
  return state.failing ? "failing" : "active";
}

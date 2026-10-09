// src/lib/ops/jobs.ts
//
// The job runner. Every scheduled job (the Vercel cron routes) and every
// job an administrator starts by hand runs through runJob(), which
//
//   - takes a lock, so the same job cannot run twice at once (a slow run and
//     the next schedule, or a "Run now" during the scheduled run). A second
//     caller gets { status: "locked" } and nothing runs;
//   - records the run: start, end, duration, outcome, a one-line summary and
//     the error, newest first, for the run-history page and the alerts.
//
// The lock is SET NX PX: it frees itself after `lockMs` even if the function
// running the job is killed mid-way (Vercel ends a function at its time
// limit), and such a run then shows as "abandoned".
//
//   neo:ops:job:lock:<name>   runId, expires after lockMs
//   neo:ops:job:run:<runId>   JobRun JSON (kept 60 days)
//   neo:ops:job:runs:<name>   list of runIds, newest first, capped at 100
//   neo:ops:job:failed        list of runIds that failed, any job, capped at 100
//   neo:ops:job:names         set of job names that have ever run
//
// For phase 10 (automation rules) — the interface to schedule through:
//
//   runJob(name, fn, { trigger: "automation", actor: "automation:<ruleId>" })
//     runs any function as a recorded, locked job. fn returns
//     { ok, summary?, error? }; a throw is recorded as a failure and handed
//     back as `error` on the result. Name an automation job after its rule
//     ("automation:<ruleId>") so its history is its own.
//   runRegisteredJob(name, { trigger: "automation", actor }) in
//     src/lib/ops/jobRegistry.ts runs one of the registered jobs (the cron
//     routes, the meeting sweep, …) exactly as its schedule would.
//   The registry entry says whether a job is safe to repeat (retrySafe); an
//   automation should only re-run jobs that are.
//   Automations are evaluated from a cron — add a route and wrap it in
//   cronRoute() (src/lib/ops/cron.ts) so its own runs are recorded too.

import { kv } from "@/lib/kv";
import { errorText, newId, parseJson } from "@/lib/ops/util";

export type JobTrigger = "schedule" | "manual" | "retry" | "automation";
export type JobOutcomeKind = "running" | "ok" | "failed" | "skipped" | "abandoned";

export interface JobRun {
  id: string;
  job: string;
  trigger: JobTrigger;
  /** Who started it: an administrator's email, "vercel-cron", "automation:<id>". */
  actor: string;
  /** The run this one retries. */
  retryOf?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  outcome: JobOutcomeKind;
  summary?: string;
  error?: string;
  lockMs: number;
}

export interface JobOutcome {
  ok: boolean;
  /** Ran but had nothing to do (e.g. mail not configured). Counts as success. */
  skipped?: boolean;
  summary?: string;
  error?: string;
}

export interface RunJobOptions {
  trigger: JobTrigger;
  actor?: string;
  retryOf?: string;
  /** How long the lock holds if the run never finishes. Default 15 minutes. */
  lockMs?: number;
}

export type RunJobResult =
  | { status: "ran"; run: JobRun; error?: unknown }
  | { status: "locked"; heldBy: string | null };

export const DEFAULT_LOCK_MS = 15 * 60 * 1000;
const RUN_TTL_SECONDS = 60 * 24 * 60 * 60;
const RUNS_CAP = 100;
const FAILED_CAP = 100;

const lockKey = (name: string) => `neo:ops:job:lock:${name}`;
const runKey = (id: string) => `neo:ops:job:run:${id}`;
const runsKey = (name: string) => `neo:ops:job:runs:${name}`;
const FAILED = "neo:ops:job:failed";
const NAMES = "neo:ops:job:names";

async function saveRun(run: JobRun): Promise<void> {
  await kv.set(runKey(run.id), JSON.stringify(run), { ex: RUN_TTL_SECONDS });
}

/** Take the lock for `name`. Returns false if another run holds it. */
export async function acquireJobLock(name: string, runId: string, lockMs = DEFAULT_LOCK_MS): Promise<boolean> {
  const r = await kv.set(lockKey(name), runId, { nx: true, px: lockMs });
  return r === "OK" || r === (true as unknown);
}

/** Release the lock only if this run still holds it. */
export async function releaseJobLock(name: string, runId: string): Promise<void> {
  const holder = await kv.get(lockKey(name));
  if (holder != null && String(holder) === runId) await kv.del(lockKey(name));
}

export async function jobLockHolder(name: string): Promise<string | null> {
  const v = await kv.get(lockKey(name));
  return v == null ? null : String(v);
}

/** Run `fn` as the job `name`: locked, timed and recorded. Never throws. */
export async function runJob(
  name: string,
  fn: (run: JobRun) => Promise<JobOutcome>,
  opts: RunJobOptions,
): Promise<RunJobResult> {
  const lockMs = opts.lockMs ?? DEFAULT_LOCK_MS;
  const run: JobRun = {
    id: newId("run"),
    job: name,
    trigger: opts.trigger,
    actor: opts.actor ?? (opts.trigger === "schedule" ? "vercel-cron" : "system"),
    ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
    startedAt: Date.now(),
    outcome: "running",
    lockMs,
  };
  if (!(await acquireJobLock(name, run.id, lockMs))) {
    return { status: "locked", heldBy: await jobLockHolder(name) };
  }
  await saveRun(run);
  await kv.lpush(runsKey(name), run.id);
  await kv.ltrim(runsKey(name), 0, RUNS_CAP - 1);
  await kv.sadd(NAMES, name);

  let thrown: unknown;
  try {
    const out = await fn(run);
    run.outcome = out.ok ? (out.skipped ? "skipped" : "ok") : "failed";
    if (out.summary) run.summary = out.summary.slice(0, 500);
    if (out.error) run.error = errorText(out.error);
  } catch (e) {
    thrown = e;
    run.outcome = "failed";
    run.error = errorText(e);
  }
  run.endedAt = Date.now();
  run.durationMs = run.endedAt - run.startedAt;
  try {
    await saveRun(run);
    if (run.outcome === "failed") {
      await kv.lpush(FAILED, run.id);
      await kv.ltrim(FAILED, 0, FAILED_CAP - 1);
    }
  } finally {
    await releaseJobLock(name, run.id);
  }
  return thrown === undefined ? { status: "ran", run } : { status: "ran", run, error: thrown };
}

function withAbandoned(run: JobRun, now = Date.now()): JobRun {
  if (run.outcome === "running" && now - run.startedAt > run.lockMs) return { ...run, outcome: "abandoned" };
  return run;
}

export async function getRun(id: string): Promise<JobRun | null> {
  const r = parseJson<JobRun>(await kv.get(runKey(id)));
  return r ? withAbandoned(r) : null;
}

async function runsFrom(listKey: string, limit: number): Promise<JobRun[]> {
  const ids = ((await kv.lrange(listKey, 0, limit - 1)) ?? []) as unknown[];
  const runs = await Promise.all(ids.map((id) => getRun(String(id))));
  return runs.filter((r): r is JobRun => !!r);
}

export function listRuns(name: string, limit = 20): Promise<JobRun[]> {
  return runsFrom(runsKey(name), Math.max(1, Math.min(limit, RUNS_CAP)));
}

export function listFailedRuns(limit = 50): Promise<JobRun[]> {
  return runsFrom(FAILED, Math.max(1, Math.min(limit, FAILED_CAP)));
}

export async function jobNames(): Promise<string[]> {
  return (((await kv.smembers(NAMES)) ?? []) as string[]).sort();
}

/** How many of the most recent finished runs failed in a row. */
export function consecutiveFailures(runs: JobRun[]): number {
  let n = 0;
  for (const r of runs) {
    if (r.outcome === "running") continue;
    if (r.outcome === "failed" || r.outcome === "abandoned") n++;
    else break;
  }
  return n;
}

/**
 * Set while an automation rule has taken a scheduled job over
 * (src/lib/automation/runner.ts): JSON { ruleId, ruleName }, with a short
 * TTL the automation dispatcher refreshes. cronRoute() skips the job's own
 * scheduled run while it is set; if the dispatcher stops, it lapses and the
 * cron runs again.
 */
export const jobReplacedKey = (name: string) => `neo:ops:job:replaced:${name}`;

/** The rule that has taken `name` over, if any. */
export async function jobReplacement(name: string): Promise<{ ruleId: string; ruleName: string } | null> {
  return parseJson<{ ruleId: string; ruleName: string }>(await kv.get(jobReplacedKey(name)));
}

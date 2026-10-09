// src/lib/automation/store.ts
//
// Automation rules and their state in KV.
//
//   neo:auto:rules                 hash ruleId -> Rule
//   neo:auto:state                 hash ruleId -> RuleState (next run, last result, failure streak)
//   neo:auto:run:<runId>           RunDetail: per-run counts, errors and items (the job runner's run id; 60 days)
//   neo:auto:idem:<ruleId>:<key>   claim: this rule already did this to this subject in this period (SET NX)
//   neo:auto:cool:<ruleId>:<uid>   this person heard from this rule recently (TTL = the cooldown)
//   neo:auto:seeded                built-in rules were added (once; deleting it re-adds missing ones)
//
// The run history itself (start, end, outcome, who started it) is the job
// runner's (src/lib/ops/jobs.ts, job "automation:<ruleId>"); RunDetail adds
// what this phase knows about a run.

import { kv } from "@/lib/kv";
import type { Rule } from "@/lib/automation/model";

const RULES = "neo:auto:rules";
const STATE = "neo:auto:state";
const runKey = (runId: string) => `neo:auto:run:${runId}`;
const idemKey = (ruleId: string, key: string) => `neo:auto:idem:${ruleId}:${key}`;
const coolKey = (ruleId: string, uid: string) => `neo:auto:cool:${ruleId}:${uid}`;
export const SEEDED = "neo:auto:seeded";

const RUN_TTL_S = 60 * 24 * 60 * 60;
/** A claim outlives any period a rule can have (a year of renewals). */
export const CLAIM_TTL_S = 400 * 24 * 60 * 60;

export interface RuleState {
  nextRunAt: number | null;
  /** A due run held back by quiet hours: the slot it belongs to. */
  heldSlot: number | null;
  lastRunAt: number | null;
  lastRunId: string | null;
  lastOutcome: "ok" | "failed" | "skipped" | "locked" | null;
  lastSummary: string | null;
  lastError: string | null;
  failureStreak: number;
  failing: boolean;
  failingSince: number | null;
}

export const EMPTY_STATE: RuleState = {
  nextRunAt: null,
  heldSlot: null,
  lastRunAt: null,
  lastRunId: null,
  lastOutcome: null,
  lastSummary: null,
  lastError: null,
  failureStreak: 0,
  failing: false,
  failingSince: null,
};

export interface RunCounts {
  /** What the rule found to act on. */
  targets: number;
  done: number;
  /** Already done in this period (an earlier run, a retry, the cron it replaced). */
  already: number;
  /** Heard from this rule within the cooldown. */
  cooling: number;
  /** Over the per-run maximum: left for the next run. */
  deferred: number;
  /** Nothing to send to (no email, opted out, …). */
  skipped: number;
  failed: number;
}

export interface RunItem {
  key: string;
  label: string;
  outcome: "done" | "already" | "cooling" | "deferred" | "skipped" | "failed" | "would_do";
  detail?: string;
}

export interface RunDetail {
  runId: string;
  ruleId: string;
  ruleVersion: number;
  /** The scheduled time the run belongs to (ms), or null for a run outside the schedule. */
  slot: number | null;
  dryRun: boolean;
  counts: RunCounts;
  errors: { target: string; message: string }[];
  items: RunItem[];
  note?: string;
}

export const zeroCounts = (): RunCounts => ({ targets: 0, done: 0, already: 0, cooling: 0, deferred: 0, skipped: 0, failed: 0 });

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

export async function listRules(): Promise<Rule[]> {
  const all = ((await kv.hgetall(RULES)) ?? {}) as Record<string, unknown>;
  return Object.values(all)
    .map((v) => parse<Rule>(v))
    .filter((r): r is Rule => !!r)
    .sort((a, b) => (a.builtIn ? 0 : 1) - (b.builtIn ? 0 : 1) || a.createdAt - b.createdAt);
}

export async function getRule(id: string): Promise<Rule | null> {
  if (!/^[a-z0-9_:-]{1,80}$/i.test(id)) return null;
  return parse<Rule>(await kv.hget(RULES, id));
}

export async function saveRule(rule: Rule): Promise<void> {
  await kv.hset(RULES, { [rule.id]: JSON.stringify(rule) });
}

export async function deleteRuleRecord(id: string): Promise<void> {
  await kv.hdel(RULES, id);
  await kv.hdel(STATE, id);
}

export async function getState(id: string): Promise<RuleState> {
  return { ...EMPTY_STATE, ...(parse<RuleState>(await kv.hget(STATE, id)) ?? {}) };
}

export async function allStates(): Promise<Record<string, RuleState>> {
  const all = ((await kv.hgetall(STATE)) ?? {}) as Record<string, unknown>;
  const out: Record<string, RuleState> = {};
  for (const [k, v] of Object.entries(all)) out[k] = { ...EMPTY_STATE, ...(parse<RuleState>(v) ?? {}) };
  return out;
}

export async function saveState(id: string, s: RuleState): Promise<void> {
  await kv.hset(STATE, { [id]: JSON.stringify(s) });
}

export async function saveRunDetail(d: RunDetail): Promise<void> {
  await kv.set(runKey(d.runId), JSON.stringify(d), { ex: RUN_TTL_S });
}

export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  return parse<RunDetail>(await kv.get(runKey(runId)));
}

/** Whether this rule already did `key` (in its period). */
export async function isClaimed(ruleId: string, key: string): Promise<boolean> {
  return (await kv.get(idemKey(ruleId, key))) != null;
}

/** Claim `key` for this rule; false if a run (this one or another) already has. */
export async function claim(ruleId: string, key: string, runId: string): Promise<boolean> {
  const r = await kv.set(idemKey(ruleId, key), runId, { nx: true, ex: CLAIM_TTL_S });
  return r === "OK" || r === (true as unknown);
}

/** Hand a claim back after the action failed, so the next run tries again. */
export async function release(ruleId: string, key: string, runId: string): Promise<void> {
  const holder = await kv.get(idemKey(ruleId, key));
  if (holder != null && String(holder) === runId) await kv.del(idemKey(ruleId, key));
}

export async function isCooling(ruleId: string, uid: string): Promise<boolean> {
  return (await kv.get(coolKey(ruleId, uid))) != null;
}

export async function startCooldown(ruleId: string, uid: string, hours: number): Promise<void> {
  if (hours > 0) await kv.set(coolKey(ruleId, uid), "1", { ex: Math.round(hours * 3600) });
}

// src/lib/automation/model.ts
//
// What an automation rule is: when it runs (a schedule, optionally with a
// condition checked on that schedule), what it does, to whom, and the
// limits it keeps (quiet hours, at most N per run, a cooldown per person).
// Pure — the editor on /admin/automation uses the same validation as the
// API, which is what enforces it.

import { describeSchedule, validateSchedule, type Schedule } from "@/lib/automation/schedule";

export type RuleStatus = "active" | "paused";

export const CONDITION_KINDS = [
  { kind: "trial_ends_in", label: "Trial ends in", unit: "days before", action: "Email (and bell) the account" },
  { kind: "renewal_due", label: "Paid plan ends in", unit: "days before", action: "Renewal reminder (billing)" },
  { kind: "payment_failed", label: "Payment failed", unit: "days after", action: "Failed-payment follow-up (billing)" },
  { kind: "meeting_cap", label: "Free meeting cap reached", unit: "% of the cap", action: "Usage reminder" },
  { kind: "recording_hours", label: "Recording hours this month", unit: "% of the allowance", action: "Usage reminder" },
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number]["kind"];

export interface Condition {
  kind: ConditionKind;
  /** trial_ends_in / renewal_due: days before; payment_failed: days after. */
  days?: number[];
  /** meeting_cap / recording_hours: percent of the allowance. */
  pct?: number;
}

export const ACTION_KINDS = [
  { kind: "reminder", label: "Send a reminder", description: "To each account the condition finds, once per account per period." },
  { kind: "announcement", label: "Send an announcement", description: "A message to an audience, through the announcement queue." },
  { kind: "subscriptions", label: "Apply plan changes and expire trials", description: "Starts scheduled plan changes and ends trials and lapsed plans." },
  { kind: "report", label: "Email a report", description: "Builds an analytics report and emails it as CSV." },
  { kind: "maintenance", label: "Routine maintenance", description: "Runs maintenance jobs: meeting sweep, KV snapshot, health checks." },
  { kind: "purge", label: "Purge expired data", description: "Deletes data past its retention period." },
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number]["kind"];

export type MessageSeverity = "info" | "warning" | "critical";

export interface Action {
  kind: ActionKind;
  /** reminder / announcement: where it is delivered. */
  channels?: { email: boolean; inApp: boolean; push?: boolean };
  /** announcement */
  message?: { title: string; body: string; severity: MessageSeverity; url: string };
  sendKind?: "announcement" | "product" | "service";
  /** announcement: an Audience as the Communication page builds it. */
  audience?: Record<string, unknown>;
  /** report */
  report?: { days: number; tables: string[]; to: "owner" | "owner_and_ops" };
  /** maintenance: registered job names. */
  jobs?: string[];
  /** purge: a retention target. */
  target?: string;
}

export interface RuleOptions {
  /** Local times (HH:MM) in the rule's timezone; a sending rule due inside them waits until the end. */
  quietHours: { start: string; end: string } | null;
  /** At most this many people (or items) per run; the rest wait for the next run. */
  maxPerRun: number;
  /** Nobody hears from this rule again within this many hours. 0 = no cooldown. */
  cooldownHours: number;
  /** Failed runs in a row before the rule is marked failing and an alert goes out. */
  failureThreshold: number;
}

export interface Rule {
  id: string;
  name: string;
  description: string;
  status: RuleStatus;
  schedule: Schedule;
  timezone: string;
  condition: Condition | null;
  action: Action;
  options: RuleOptions;
  /** A registered job (cron) this rule takes over: while the rule is active the cron does not also run. */
  replaces: string | null;
  /** Seeded rules keep their key; they can be paused and edited but not deleted. */
  builtIn: string | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  version: number;
}

export const DEFAULT_OPTIONS: RuleOptions = { quietHours: null, maxPerRun: 500, cooldownHours: 0, failureThreshold: 3 };
export const MAX_PER_RUN = 5000;

/** Actions that reach people: quiet hours and cooldowns apply. */
export function sendsToPeople(a: Pick<Action, "kind">): boolean {
  return a.kind === "reminder" || a.kind === "announcement" || a.kind === "report";
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class RuleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function bad(code: string, message: string): never {
  throw new RuleError(code, message);
}

function days(v: unknown, max: number): number[] {
  if (!Array.isArray(v)) bad("invalid_condition", "Give one to five whole numbers of days.");
  const out = [...new Set(v.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= max).sort((a, b) => b - a);
  if (!out.length || out.length > 5 || out.length !== v.length) bad("invalid_condition", `Give one to five whole numbers of days, 0–${max}.`);
  return out;
}

export function cleanCondition(raw: unknown): Condition | null {
  if (raw == null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "trial_ends_in":
    case "renewal_due":
      return { kind: r.kind, days: days(r.days, 60) };
    case "payment_failed":
      return { kind: r.kind, days: days(r.days, 30) };
    case "meeting_cap":
    case "recording_hours": {
      const pct = Number(r.pct);
      if (!Number.isInteger(pct) || pct < 10 || pct > 100) bad("invalid_condition", "The percentage is a whole number from 10 to 100.");
      return { kind: r.kind, pct };
    }
    default:
      return bad("invalid_condition", "Choose a condition.");
  }
}

export function cleanAction(raw: unknown, condition: Condition | null, jobNames: string[], purgeTargets: string[]): Action {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind as ActionKind;
  if (!ACTION_KINDS.some((a) => a.kind === kind)) bad("invalid_action", "Choose what the rule does.");
  const ch = (r.channels ?? {}) as Record<string, unknown>;
  const channels = { email: ch.email !== false, inApp: ch.inApp !== false, push: ch.push === true };
  switch (kind) {
    case "reminder": {
      if (!condition) bad("invalid_action", "A reminder needs a condition: who is reminded, and of what.");
      if (!channels.email && !channels.inApp) bad("invalid_action", "Choose email, the bell, or both.");
      return { kind, channels: { email: channels.email, inApp: channels.inApp } };
    }
    case "announcement": {
      if (condition) bad("invalid_action", "An announcement goes to an audience, not to a condition. Remove the condition.");
      const m = (r.message ?? {}) as Record<string, unknown>;
      const title = text(m.title, 120);
      const body = text(m.body, 4000);
      if (!title || !body) bad("invalid_action", "The announcement needs a title and a message.");
      const severity = (["info", "warning", "critical"] as const).find((s) => s === m.severity) ?? "info";
      const url = text(m.url, 300);
      if (url && !url.startsWith("/")) bad("invalid_action", "The link is a path on this site, starting with /.");
      const sendKind = (["announcement", "product", "service"] as const).find((s) => s === r.sendKind) ?? "announcement";
      if (!channels.email && !channels.inApp && !channels.push) bad("invalid_action", "Choose at least one channel.");
      if (!r.audience || typeof r.audience !== "object") bad("invalid_action", "Choose who the announcement goes to.");
      return { kind, channels, message: { title, body, severity, url }, sendKind, audience: r.audience as Record<string, unknown> };
    }
    case "report": {
      const rep = (r.report ?? {}) as Record<string, unknown>;
      const d = Number(rep.days ?? 7);
      if (!Number.isInteger(d) || d < 1 || d > 92) bad("invalid_action", "The report covers 1 to 92 days.");
      const tables = Array.isArray(rep.tables) ? rep.tables.map(String).filter((t) => REPORT_TABLES.includes(t)) : ["summary"];
      if (!tables.length) bad("invalid_action", `Choose what the report includes: ${REPORT_TABLES.join(", ")}.`);
      const to = rep.to === "owner_and_ops" ? "owner_and_ops" : "owner";
      return { kind, report: { days: d, tables, to } };
    }
    case "maintenance": {
      const jobs = Array.isArray(r.jobs) ? [...new Set(r.jobs.map(String))] : [];
      const unknown = jobs.filter((j) => !jobNames.includes(j));
      if (!jobs.length) bad("invalid_action", "Choose at least one maintenance job.");
      if (unknown.length) bad("invalid_action", `Not a job that is safe to run again: ${unknown.join(", ")}.`);
      return { kind, jobs };
    }
    case "subscriptions":
      return { kind };
    case "purge": {
      const target = text(r.target, 60);
      if (!purgeTargets.length) bad("invalid_action", "No data has a retention rule to purge by yet.");
      if (!purgeTargets.includes(target)) bad("invalid_action", "Choose what to purge.");
      return { kind, target };
    }
  }
  return bad("invalid_action", "Choose what the rule does.");
}

export const REPORT_TABLES = ["summary", "daily", "features", "retention", "accounts", "plans"];

export function cleanOptions(raw: unknown): RuleOptions {
  const r = (raw ?? {}) as Record<string, unknown>;
  const int = (v: unknown, def: number, lo: number, hi: number, label: string) => {
    if (v === undefined || v === null || v === "") return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) bad("invalid_options", `${label}: a whole number from ${lo} to ${hi}.`);
    return n;
  };
  let quietHours: RuleOptions["quietHours"] = null;
  const q = r.quietHours as Record<string, unknown> | null | undefined;
  if (q && (q.start || q.end)) {
    const start = text(q.start, 5);
    const end = text(q.end, 5);
    if (!HHMM.test(start) || !HHMM.test(end) || start === end) bad("invalid_options", "Quiet hours are two different times like 21:00 and 07:00.");
    quietHours = { start, end };
  }
  return {
    quietHours,
    maxPerRun: int(r.maxPerRun, DEFAULT_OPTIONS.maxPerRun, 1, MAX_PER_RUN, "At most per run"),
    cooldownHours: int(r.cooldownHours, DEFAULT_OPTIONS.cooldownHours, 0, 24 * 90, "Cooldown hours"),
    failureThreshold: int(r.failureThreshold, DEFAULT_OPTIONS.failureThreshold, 1, 20, "Failures before alerting"),
  };
}

export interface RuleInput {
  name: string;
  description: string;
  schedule: Schedule;
  timezone: string;
  condition: Condition | null;
  action: Action;
  options: RuleOptions;
  replaces: string | null;
}

/**
 * The editable part of a rule from a request body. `jobNames` are the jobs
 * maintenance may run (safe to repeat); `replaceable` the crons a rule may
 * take over; `purgeTargets` the retention targets.
 */
export function cleanRuleInput(
  raw: unknown,
  ctx: { jobNames: string[]; replaceable: string[]; purgeTargets: string[] },
): RuleInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = text(r.name, 80);
  if (!name) bad("invalid_name", "Give the rule a name.");
  const timezone = text(r.timezone, 64) || "UTC";
  const schedule = r.schedule as Schedule;
  const err = validateSchedule(schedule, timezone);
  if (err) bad("invalid_schedule", err);
  const condition = cleanCondition(r.condition);
  const action = cleanAction(r.action, condition, ctx.jobNames, ctx.purgeTargets);
  if (action.kind !== "reminder" && condition) bad("invalid_action", "Only a reminder acts on a condition.");
  const replaces = r.replaces ? text(r.replaces, 80) : null;
  if (replaces && !ctx.replaceable.includes(replaces)) bad("invalid_replaces", `${replaces} is not a scheduled job a rule can take over.`);
  return {
    name,
    description: text(r.description, 500),
    schedule: normaliseSchedule(schedule),
    timezone,
    condition,
    action,
    options: cleanOptions(r.options),
    replaces,
  };
}

function normaliseSchedule(s: Schedule): Schedule {
  if (s.type === "cron") return { type: "cron", expr: s.expr.trim().replace(/\s+/g, " ") };
  const out: Schedule = { type: "every", unit: s.unit, n: s.n };
  if (s.unit === "hours") out.minute = s.minute ?? 0;
  if (s.unit === "days") {
    out.at = s.at;
    if (s.anchorDay) out.anchorDay = s.anchorDay;
  }
  return out;
}

/** A one-line description of what the rule does, for the list. */
export function describeRule(r: Pick<Rule, "schedule" | "timezone" | "condition" | "action">): string {
  const when = describeSchedule(r.schedule, r.timezone);
  const c = r.condition;
  const cond = c
    ? c.kind === "meeting_cap" || c.kind === "recording_hours"
      ? `${CONDITION_KINDS.find((k) => k.kind === c.kind)!.label} at ${c.pct}%`
      : `${CONDITION_KINDS.find((k) => k.kind === c.kind)!.label} ${c.days!.join(" / ")} day${c.days!.length === 1 && c.days![0] === 1 ? "" : "s"}${c.kind === "payment_failed" ? " ago" : ""}`
    : "";
  const what = ACTION_KINDS.find((a) => a.kind === r.action.kind)?.label ?? r.action.kind;
  return `${when}: ${cond ? `${cond} → ` : ""}${what}`;
}

/** Whether `ts` falls inside the quiet hours, read on the wall clock of `local` (h, mi). */
export function inQuietHours(q: RuleOptions["quietHours"], local: { h: number; mi: number }): boolean {
  if (!q) return false;
  const m = local.h * 60 + local.mi;
  const [sh, sm] = q.start.split(":").map(Number);
  const [eh, em] = q.end.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

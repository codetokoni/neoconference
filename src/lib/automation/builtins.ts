// src/lib/automation/builtins.ts
//
// The rules every platform starts with, added once (neo:auto:seeded). All
// paused except one: "Trial expiry and plan changes" does exactly what the
// downgrade-expired-plans cron did — the same job, the same time (02:00
// UTC) — so it starts active and takes that cron over (its scheduled run
// then stands down; see syncReplacements in runner.ts). Pausing the rule
// hands the job back to the cron.
//
// The others would change what the platform does today (send email, run a
// sweep that only ran on reads), so an administrator turns them on.

import { kv } from "@/lib/kv";
import { DEFAULT_OPTIONS, type Rule } from "@/lib/automation/model";
import { getRule, saveRule, SEEDED } from "@/lib/automation/store";

type Seed = Omit<Rule, "createdAt" | "createdBy" | "updatedAt" | "updatedBy" | "version">;

export const BUILT_IN_RULES: Seed[] = [
  {
    id: "builtin_trial_expiry",
    builtIn: "trial_expiry",
    name: "Trial expiry and plan changes",
    description:
      "Every night: ends trials and lapsed or cancelled plans (back to Free) and starts plan changes scheduled for that date. Replaces the downgrade-expired-plans cron, at the same time.",
    status: "active",
    schedule: { type: "cron", expr: "0 2 * * *" },
    timezone: "UTC",
    condition: null,
    action: { kind: "subscriptions" },
    options: { ...DEFAULT_OPTIONS, maxPerRun: 5000 },
    replaces: "downgrade-expired-plans",
  },
  {
    id: "builtin_trial_ending",
    builtIn: "trial_ending",
    name: "Trial ending reminder",
    description: "Tells people their trial ends in 3 days and again the day before.",
    status: "paused",
    schedule: { type: "every", unit: "hours", n: 1, minute: 0 },
    timezone: "UTC",
    condition: { kind: "trial_ends_in", days: [3, 1] },
    action: { kind: "reminder", channels: { email: true, inApp: true } },
    options: { ...DEFAULT_OPTIONS, quietHours: { start: "21:00", end: "08:00" } },
    replaces: null,
  },
  {
    id: "builtin_renewal",
    builtIn: "renewal",
    name: "Renewal reminders",
    description: "Reminds people 7, 3 and 1 days before a paid plan runs out (plans do not renew by themselves).",
    status: "paused",
    schedule: { type: "cron", expr: "0 9 * * *" },
    timezone: "UTC",
    condition: { kind: "renewal_due", days: [7, 3, 1] },
    action: { kind: "reminder", channels: { email: true, inApp: false } },
    options: { ...DEFAULT_OPTIONS },
    replaces: null,
  },
  {
    id: "builtin_failed_payment",
    builtIn: "failed_payment",
    name: "Failed payment follow-up",
    description: "Follows up 1 and 3 days after a plan payment failed, unless they have paid since.",
    status: "paused",
    schedule: { type: "cron", expr: "0 10 * * *" },
    timezone: "UTC",
    condition: { kind: "payment_failed", days: [3, 1] },
    action: { kind: "reminder", channels: { email: true, inApp: false } },
    options: { ...DEFAULT_OPTIONS },
    replaces: null,
  },
  {
    id: "builtin_usage_meetings",
    builtIn: "usage_meetings",
    name: "Usage alert: free meeting cap at 80%",
    description: "Tells Free accounts when they have used 80% of their lifetime meetings. Once per account.",
    status: "paused",
    schedule: { type: "cron", expr: "30 8 * * *" },
    timezone: "UTC",
    condition: { kind: "meeting_cap", pct: 80 },
    action: { kind: "reminder", channels: { email: true, inApp: true } },
    options: { ...DEFAULT_OPTIONS },
    replaces: null,
  },
  {
    id: "builtin_usage_recording",
    builtIn: "usage_recording",
    name: "Usage alert: recording hours at 90%",
    description: "Tells accounts when they have used 90% of this month's recording hours. Once a month.",
    status: "paused",
    schedule: { type: "every", unit: "hours", n: 6, minute: 15 },
    timezone: "UTC",
    condition: { kind: "recording_hours", pct: 90 },
    action: { kind: "reminder", channels: { email: true, inApp: true } },
    options: { ...DEFAULT_OPTIONS, quietHours: { start: "21:00", end: "08:00" } },
    replaces: null,
  },
  {
    id: "builtin_weekly_report",
    builtIn: "weekly_report",
    name: "Weekly summary to the owner",
    description: "Every Monday morning: last week's figures, emailed to the platform owner as CSV.",
    status: "paused",
    schedule: { type: "cron", expr: "0 7 * * 1" },
    timezone: "UTC",
    condition: null,
    action: { kind: "report", report: { days: 7, tables: ["summary", "daily"], to: "owner" } },
    options: { ...DEFAULT_OPTIONS },
    replaces: null,
  },
  {
    id: "builtin_nightly_maintenance",
    builtIn: "nightly_maintenance",
    name: "Nightly maintenance",
    description: "Every night: ends meetings still marked live whose room is gone (the sweep otherwise runs only when meetings are listed).",
    status: "paused",
    schedule: { type: "cron", expr: "15 3 * * *" },
    timezone: "UTC",
    condition: null,
    action: { kind: "maintenance", jobs: ["meeting-sweep"] },
    options: { ...DEFAULT_OPTIONS },
    replaces: null,
  },
];

/**
 * Add the built-in rules the first time anything reads the rules. Missing
 * ones only — an administrator's edits are never overwritten. Returns the
 * ids added.
 */
export async function ensureBuiltIns(now = Date.now()): Promise<string[]> {
  if (await kv.get(SEEDED)) return [];
  const added: string[] = [];
  for (const seed of BUILT_IN_RULES) {
    if (await getRule(seed.id)) continue;
    await saveRule({ ...seed, createdAt: now, createdBy: "system", updatedAt: now, updatedBy: "system", version: 1 });
    added.push(seed.id);
  }
  await kv.set(SEEDED, String(now));
  return added;
}

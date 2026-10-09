// src/lib/automation/admin.ts — what the /api/admin/automation routes share:
// validation context, the step-up rule, and the shape the page reads.

import { describeRule, RuleError, type Rule, type RuleInput } from "@/lib/automation/model";
import { describeSchedule, upcomingRuns } from "@/lib/automation/schedule";
import { actionFor, maintenanceJobs, PURGE_TARGETS, replaceableJobs } from "@/lib/automation/actions";
import { listRules, type RuleState } from "@/lib/automation/store";
import { jobName, ruleStatus } from "@/lib/automation/runner";
import { STEP_UP_RECIPIENTS } from "@/lib/comms/sends";
import { fail } from "@/lib/admin/http";

export { STEP_UP_RECIPIENTS };

export function editContext() {
  return {
    jobNames: maintenanceJobs().map((j) => j.name),
    replaceable: replaceableJobs().map((j) => j.name),
    purgeTargets: PURGE_TARGETS.map((p) => p.id),
  };
}

export function newRuleId(): string {
  return `rule_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** A RuleError as the API's answer. */
export function ruleErrorResponse(e: unknown) {
  if (e instanceof RuleError) return fail(e.code, e.message);
  throw e;
}

/** Another active rule already replaces this job. */
export async function replacementClash(rule: Pick<Rule, "id" | "replaces" | "status">): Promise<Rule | null> {
  if (!rule.replaces || rule.status !== "active") return null;
  return (await listRules()).find((r) => r.id !== rule.id && r.status === "active" && r.replaces === rule.replaces) ?? null;
}

/**
 * How far a run of this rule would reach now, and whether acting on it
 * needs a fresh authenticator code: a rule that deletes data always does; a
 * rule that would reach more than STEP_UP_RECIPIENTS people does. When the
 * reach cannot be worked out, it asks — the safe side.
 */
export async function stepUpNeeded(rule: Rule, now = Date.now()): Promise<{ needed: boolean; reach: number | null; reason: string | null }> {
  if (rule.action.kind === "purge") return { needed: true, reach: null, reason: "This rule deletes data." };
  if (rule.action.kind === "maintenance" || rule.action.kind === "subscriptions") return { needed: false, reach: null, reason: null };
  try {
    const plan = await actionFor(rule).plan({ rule, now, slot: null, runId: "stepup", actor: jobName(rule.id) });
    const reach = plan.recipients ?? plan.targets.length;
    return reach > STEP_UP_RECIPIENTS
      ? { needed: true, reach, reason: `This rule would reach ${reach} people (more than ${STEP_UP_RECIPIENTS}).` }
      : { needed: false, reach, reason: null };
  } catch (e) {
    return { needed: true, reach: null, reason: `Could not count who this rule reaches (${e instanceof Error ? e.message : String(e)}).` };
  }
}

/** The audited fields of a rule, for before/after. */
export function auditView(r: Pick<Rule, keyof RuleInput | "status">) {
  return {
    name: r.name,
    description: r.description,
    status: r.status,
    schedule: r.schedule,
    timezone: r.timezone,
    condition: r.condition,
    action: r.action,
    options: r.options,
    replaces: r.replaces,
  };
}

export function ruleView(rule: Rule, state: RuleState, now = Date.now()) {
  let upcoming: number[] = [];
  try {
    upcoming = rule.status === "active" ? upcomingRuns(rule.schedule, rule.timezone, now, 3) : [];
  } catch {
    upcoming = [];
  }
  return {
    ...rule,
    job: jobName(rule.id),
    summary: describeRule(rule),
    scheduleText: describeSchedule(rule.schedule, rule.timezone),
    status: rule.status,
    health: ruleStatus(rule, state),
    state,
    nextRunAt: rule.status === "active" ? state.nextRunAt ?? upcoming[0] ?? null : null,
    upcoming,
  };
}

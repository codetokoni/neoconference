// /api/admin/automation — automation rules.
//
// GET  (ops:read)          every rule with its status, last and next run, and what the editor offers
// POST (automation:write)  create a rule. A fresh authenticator code when it deletes data or would
//                          reach more than STEP_UP_RECIPIENTS people.

import { NextResponse } from "next/server";
import { actorOf, can, refuse, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { ACTION_KINDS, CONDITION_KINDS, cleanRuleInput, REPORT_TABLES, type Rule } from "@/lib/automation/model";
import { MINUTE_STEPS, HOUR_STEPS } from "@/lib/automation/schedule";
import { allStates, EMPTY_STATE, getState, listRules, saveRule } from "@/lib/automation/store";
import { ensureBuiltIns } from "@/lib/automation/builtins";
import { maintenanceJobs, PURGE_TARGETS, replaceableJobs } from "@/lib/automation/actions";
import { reschedule, syncReplacements } from "@/lib/automation/runner";
import { getPlatformSettings } from "@/lib/platform/settings";
import { auditView, editContext, newRuleId, replacementClash, ruleErrorResponse, ruleView, stepUpNeeded, STEP_UP_RECIPIENTS } from "@/lib/automation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  await ensureBuiltIns();
  const [rules, states] = await Promise.all([listRules(), allStates()]);
  const now = Date.now();
  // New rules start in the admin timezone (Settings → Regional); "local" means the browser's, so the page picks.
  const regional = await getPlatformSettings().then((p) => p.regional).catch(() => null);
  const adminTimezone = regional && regional.adminTimezone !== "local" ? regional.adminTimezone : null;
  return NextResponse.json({
    ok: true,
    now,
    canWrite: can(g.ctx, "automation:write"),
    rules: rules.map((r) => ruleView(r, states[r.id] ?? EMPTY_STATE, now)),
    meta: {
      actions: ACTION_KINDS,
      conditions: CONDITION_KINDS,
      reportTables: REPORT_TABLES,
      jobs: maintenanceJobs(),
      replaceable: replaceableJobs(),
      purgeTargets: PURGE_TARGETS.map((p) => ({ id: p.id, label: p.label })),
      minuteSteps: MINUTE_STEPS,
      hourSteps: HOUR_STEPS,
      stepUpRecipients: STEP_UP_RECIPIENTS,
      adminTimezone,
    },
  });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "automation:write");
  if (!g.ok) return g.response;
  const body = await readJson(req);
  let input;
  try {
    input = cleanRuleInput(body, editContext());
  } catch (e) {
    return ruleErrorResponse(e);
  }
  const now = Date.now();
  const status = body?.status === "active" ? "active" : "paused";
  const rule: Rule = { id: newRuleId(), ...input, status, builtIn: null, createdAt: now, createdBy: g.ctx.email, updatedAt: now, updatedBy: g.ctx.email, version: 1 };
  const clash = await replacementClash(rule);
  if (clash) return fail("already_replaced", `"${clash.name}" already takes over ${rule.replaces}. Pause it first.`, 409);
  const step = await stepUpNeeded(rule, now);
  if (step.needed && !g.ctx.mfa.stepUpFresh) return refuse("step_up_required", { reason: step.reason });
  await saveRule(rule);
  await reschedule(rule, now);
  await syncReplacements([rule]);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "automation.create",
    targetType: "automation_rule",
    targetId: rule.id,
    targetLabel: rule.name,
    after: auditView(rule),
    ...(step.reach != null ? { note: `Reaches ${step.reach} now.` } : {}),
  });
  return NextResponse.json({ ok: true, rule: ruleView(rule, await getState(rule.id), now) }, { status: 201 });
}

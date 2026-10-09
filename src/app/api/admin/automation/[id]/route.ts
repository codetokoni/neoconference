// /api/admin/automation/[id] — one automation rule.
//
// GET    (ops:read)          the rule, its state, upcoming runs and execution history
// PATCH  (automation:write)  edit (status changes go through ./status). Step-up as for create.
// DELETE (automation:write)  delete a rule you made; built-in rules can only be paused

import { NextResponse } from "next/server";
import { actorOf, refuse, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { cleanRuleInput, type Rule } from "@/lib/automation/model";
import { deleteRuleRecord, getRule, getState, saveRule } from "@/lib/automation/store";
import { reschedule, ruleHistory, syncReplacements } from "@/lib/automation/runner";
import { auditView, editContext, replacementClash, ruleErrorResponse, ruleView, stepUpNeeded } from "@/lib/automation/admin";
import { ensureBuiltIns } from "@/lib/automation/builtins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function GET(req: Request, { params }: Ctx) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  await ensureBuiltIns();
  const rule = await getRule(params.id);
  if (!rule) return fail("not_found", "No such rule.", 404);
  const [state, history] = await Promise.all([getState(rule.id), ruleHistory(rule.id, 30)]);
  return NextResponse.json({ ok: true, rule: ruleView(rule, state), history });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const g = await requireAdmin(req, "automation:write");
  if (!g.ok) return g.response;
  const before = await getRule(params.id);
  if (!before) return fail("not_found", "No such rule.", 404);
  const body = await readJson(req);
  let input;
  try {
    // Fields left out keep their values.
    input = cleanRuleInput({ ...auditView(before), ...(body ?? {}) }, editContext());
  } catch (e) {
    return ruleErrorResponse(e);
  }
  const now = Date.now();
  const after: Rule = { ...before, ...input, updatedAt: now, updatedBy: g.ctx.email, version: before.version + 1 };
  const changes = diff(auditView(before), auditView(after));
  if (!Object.keys(changes.after).length) return NextResponse.json({ ok: true, unchanged: true, rule: ruleView(before, await getState(before.id), now) });
  const clash = await replacementClash(after);
  if (clash) return fail("already_replaced", `"${clash.name}" already takes over ${after.replaces}. Pause it first.`, 409);
  const step = await stepUpNeeded(after, now);
  if (step.needed && !g.ctx.mfa.stepUpFresh) return refuse("step_up_required", { reason: step.reason });
  await saveRule(after);
  // A new schedule takes effect from now; an unchanged one keeps its next run.
  const scheduleChanged = "schedule" in changes.after || "timezone" in changes.after;
  const state = scheduleChanged ? await reschedule(after, now) : await getState(after.id);
  if (before.replaces !== after.replaces) await syncReplacements([{ ...before, status: "paused" }]);
  await syncReplacements([after]);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "automation.update",
    targetType: "automation_rule",
    targetId: after.id,
    targetLabel: after.name,
    before: changes.before,
    after: changes.after,
  });
  return NextResponse.json({ ok: true, rule: ruleView(after, state, now) });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const g = await requireAdmin(req, "automation:write");
  if (!g.ok) return g.response;
  const rule = await getRule(params.id);
  if (!rule) return fail("not_found", "No such rule.", 404);
  if (rule.builtIn) return fail("built_in", "Built-in rules cannot be deleted. Pause it instead.", 409);
  await syncReplacements([{ ...rule, status: "paused" }]);
  await deleteRuleRecord(rule.id);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "automation.delete",
    targetType: "automation_rule",
    targetId: rule.id,
    targetLabel: rule.name,
    before: auditView(rule),
  });
  return NextResponse.json({ ok: true });
}

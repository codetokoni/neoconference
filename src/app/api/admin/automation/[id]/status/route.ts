// POST /api/admin/automation/[id]/status { status: "active" | "paused" } — pause or resume.
// automation:write. Resuming a rule that deletes data or reaches more than
// STEP_UP_RECIPIENTS people needs a fresh authenticator code. Pausing a rule
// that replaced a cron hands the job back to that cron at once.

import { NextResponse } from "next/server";
import { actorOf, refuse, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { getRule, getState, saveRule, saveState } from "@/lib/automation/store";
import { reschedule, syncReplacements } from "@/lib/automation/runner";
import { replacementClash, ruleView, stepUpNeeded } from "@/lib/automation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "automation:write");
  if (!g.ok) return g.response;
  const rule = await getRule(params.id);
  if (!rule) return fail("not_found", "No such rule.", 404);
  const body = await readJson<{ status?: unknown }>(req);
  const status = body?.status;
  if (status !== "active" && status !== "paused") return fail("invalid_status", "Status is active or paused.");
  const now = Date.now();
  if (rule.status === status) return NextResponse.json({ ok: true, unchanged: true, rule: ruleView(rule, await getState(rule.id), now) });
  const after = { ...rule, status, updatedAt: now, updatedBy: g.ctx.email, version: rule.version + 1 } as typeof rule;
  if (status === "active") {
    const clash = await replacementClash(after);
    if (clash) return fail("already_replaced", `"${clash.name}" already takes over ${after.replaces}. Pause it first.`, 409);
    const step = await stepUpNeeded(after, now);
    if (step.needed && !g.ctx.mfa.stepUpFresh) return refuse("step_up_required", { reason: step.reason });
  }
  await saveRule(after);
  const state = await reschedule(after, now);
  if (status === "active") {
    // A fresh start: an old failure streak does not carry over.
    await saveState(after.id, { ...state, failureStreak: 0 });
  }
  await syncReplacements([after]);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: status === "active" ? "automation.resume" : "automation.pause",
    targetType: "automation_rule",
    targetId: rule.id,
    targetLabel: rule.name,
    before: { status: rule.status },
    after: { status },
  });
  return NextResponse.json({ ok: true, rule: ruleView(after, await getState(after.id), now) });
}

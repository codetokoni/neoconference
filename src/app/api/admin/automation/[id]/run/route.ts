// POST /api/admin/automation/[id]/run — "Run now". automation:write; a fresh
// authenticator code when the rule deletes data or reaches more than
// STEP_UP_RECIPIENTS people. Runs through the job runner under the rule's
// lock, like a scheduled run, in the period of its latest scheduled time — so
// what a scheduled run already did this period is not done again. Works on
// a paused rule too; it does not change the next scheduled run.

import { NextResponse } from "next/server";
import { actorOf, refuse, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { getRule, getState } from "@/lib/automation/store";
import { runRule } from "@/lib/automation/runner";
import { ruleView, stepUpNeeded } from "@/lib/automation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "automation:write");
  if (!g.ok) return g.response;
  const rule = await getRule(params.id);
  if (!rule) return fail("not_found", "No such rule.", 404);
  const now = Date.now();
  const step = await stepUpNeeded(rule, now);
  if (step.needed && !g.ctx.mfa.stepUpFresh) return refuse("step_up_required", { reason: step.reason });
  const r = await runRule(rule, { now, trigger: "manual", by: g.ctx.email });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "automation.run",
    targetType: "automation_rule",
    targetId: rule.id,
    targetLabel: rule.name,
    after: { runId: r.run?.id ?? null, status: r.status, outcome: r.run?.outcome ?? null, counts: r.detail.counts },
    outcome: r.status === "ran" && r.ok ? "ok" : "failed",
    ...(r.error ? { note: r.error.slice(0, 300) } : {}),
  });
  if (r.status === "locked") return fail("already_running", "This rule is running now. Try again when it finishes.", 409);
  return NextResponse.json({ ok: r.ok, run: r.run, detail: r.detail, error: r.error, rule: ruleView(rule, await getState(rule.id), now) });
}

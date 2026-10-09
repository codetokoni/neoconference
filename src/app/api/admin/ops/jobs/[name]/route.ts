// /api/admin/ops/jobs/<name>
//
// GET  (ops:read)   the job's run history (up to 100)
// POST (ops:write)  { action: "run" } runs it now; { action: "retry", runId }
//                   re-runs a failed run. Only for jobs whose registry entry
//                   says a second run is safe — anything else is refused.
//                   The job's own lock applies: 409 while it is running.
//                   Audited, including refusals.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { jobDef, runRegisteredJob } from "@/lib/ops/jobRegistry";
import { getRun, listRuns } from "@/lib/ops/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: { name: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  return NextResponse.json({ ok: true, job: params.name, runs: await listRuns(params.name, 100) });
}

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "ops:write");
  if (!g.ok) return g.response;
  const def = jobDef(params.name);
  if (!def) return fail("not_found", "No such job.", 404);
  const body = await readJson<{ action?: unknown; runId?: unknown }>(req);
  const action = body?.action === "retry" ? "retry" : body?.action === "run" ? "run" : null;
  if (!action) return fail("bad_action", "Say run or retry.");
  const actor = actorOf(g.ctx);
  const audit = (outcome: "ok" | "denied" | "failed", extra: Record<string, unknown>) =>
    recordAdminAction(actor, req, { action: `ops.job.${action}`, targetType: "job", targetId: def.name, targetLabel: def.label, outcome, after: extra });

  if (!def.retrySafe) {
    await audit("denied", { reason: "not_retry_safe" });
    return fail("not_retry_safe", `${def.label} is not safe to run again from here: ${def.retryNote}`, 409);
  }
  let retryOf: string | undefined;
  if (action === "retry") {
    retryOf = str(body?.runId, 80);
    const prev = retryOf ? await getRun(retryOf) : null;
    if (!prev || prev.job !== def.name) return fail("run_not_found", "No such run of this job.", 404);
    if (prev.outcome !== "failed" && prev.outcome !== "abandoned") return fail("not_failed", "Only a failed run can be retried.", 409);
  }
  const r = await runRegisteredJob(def.name, { trigger: action === "retry" ? "retry" : "manual", actor: g.ctx.email, retryOf });
  if (r.locked) {
    await audit("denied", { reason: "already_running" });
    return fail("already_running", `${def.label} is running now; it cannot run twice at once.`, 409);
  }
  await audit(r.run?.outcome === "failed" ? "failed" : "ok", { runId: r.run?.id, outcome: r.run?.outcome, summary: r.run?.summary, error: r.run?.error, ...(retryOf ? { retryOf } : {}) });
  return NextResponse.json({ ok: true, run: r.run });
}

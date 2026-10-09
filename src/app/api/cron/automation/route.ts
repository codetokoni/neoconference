// /api/cron/automation — the one dispatcher for automation rules (vercel.json,
// every 5 minutes). Runs each active rule whose time has come through the
// job runner, and keeps the crons that active rules replace quiet
// (src/lib/automation/runner.ts). Wrapped in cronRoute, so its own runs are
// recorded and two ticks never overlap. Auth as the other crons.

import { NextResponse } from "next/server";
import { cronRoute, isCronRequest } from "@/lib/ops/cron";
import { DISPATCH_JOB, runDueRules } from "@/lib/automation/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sum = await runDueRules(Date.now());
  // Failed rules are the rules' own failures (history, alerts); the dispatcher itself did its job.
  return NextResponse.json({ ok: true, ...sum, ...(sum.due === 0 ? { skipped: "nothing_due" } : {}) });
}

export const GET = cronRoute(DISPATCH_JOB, handle, { lockMs: 10 * 60 * 1000 });

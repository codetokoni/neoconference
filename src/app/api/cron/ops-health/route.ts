// src/app/api/cron/ops-health/route.ts
//
// Every 5 minutes (vercel.json): probe every dependency (read-only), keep
// the results for the history chart, evaluate the alert rules, and start or
// end scheduled maintenance windows; until it finishes, 20 s of the one-off
// retention sweep (src/lib/ops/retentionSweep.ts). Run through the ops job runner, so it
// is locked against itself and shows on Operations > Jobs. Auth as the
// other cron routes: Bearer CRON_SECRET, or Vercel's cron header.

import { NextResponse, type NextRequest } from "next/server";
import { cronRoute, isCronRequest } from "@/lib/ops/cron";
import { runHealthChecks } from "@/lib/ops/probes";
import { evaluateAlerts } from "@/lib/ops/alerts";
import { applyMaintenanceWindows } from "@/lib/ops/incidents";
import { runRetentionSweep } from "@/lib/ops/retentionSweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await runHealthChecks();
  const alerts = await evaluateAlerts(results);
  const windows = await applyMaintenanceWindows();
  // Once, a little each run: older data onto the November 2026 retention periods.
  const sweep = await runRetentionSweep({ budgetMs: 20_000 }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return NextResponse.json({
    ok: true,
    up: count("up"),
    degraded: count("degraded"),
    down: count("down"),
    notConfigured: count("not_configured"),
    alerts,
    maintenanceChanged: windows.map((w) => `${w.id}:${w.state}`),
    retentionSweep: "error" in sweep ? sweep : sweep.done ? "done" : { removed: sweep.removed, shortened: sweep.shortened, rule: sweep.rule },
  });
}

export const GET = cronRoute("ops-health", handle, { lockMs: 4 * 60 * 1000 });

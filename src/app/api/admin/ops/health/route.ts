// /api/admin/ops/health — service health.
//
// GET  (ops:read)  every probe's latest result and its 24-hour history
// POST (ops:read)  run the probes now (read-only against every provider);
//                  { only?: string[] } to run some. Audited.
//
// Results never carry secrets: probe details are redacted at the source.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { readJson } from "@/lib/admin/http";
import { PROBES, healthHistory, latestResults, runHealthChecks } from "@/lib/ops/probes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function describe() {
  return PROBES.map((p) => ({ id: p.id, label: p.label, group: p.group, needs: p.needs }));
}

export async function GET(req: Request) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  const latest = await latestResults();
  const history: Record<string, Awaited<ReturnType<typeof healthHistory>>> = {};
  await Promise.all(PROBES.map(async (p) => (history[p.id] = await healthHistory(p.id))));
  return NextResponse.json({ ok: true, probes: describe(), latest, history });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  const body = await readJson<{ only?: unknown }>(req);
  const only = Array.isArray(body?.only) ? body!.only.filter((x): x is string => typeof x === "string" && PROBES.some((p) => p.id === x)) : undefined;
  const results = await runHealthChecks(only);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "ops.health.check",
    targetType: "system",
    targetLabel: only?.length ? only.join(", ") : "all services",
    after: Object.fromEntries(results.map((r) => [r.id, r.status])),
  });
  return NextResponse.json({ ok: true, results });
}

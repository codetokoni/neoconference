// /api/admin/ops/incidents
//
// GET  (ops:read)   incidents and maintenance windows
// POST (ops:write)  { title, impact, status, services[], message, showBanner }
//                   open an incident; with showBanner it is put in the
//                   site-wide notice (the Settings one). Audited.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { createIncident, isImpact, isIncidentStatus, listIncidents, listMaintenance } from "@/lib/ops/incidents";
import { PROBES } from "@/lib/ops/probes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  const [incidents, maintenance] = await Promise.all([listIncidents(), listMaintenance()]);
  return NextResponse.json({ ok: true, incidents, maintenance, services: PROBES.map((p) => ({ id: p.id, label: p.label })) });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "ops:write");
  if (!g.ok) return g.response;
  const b = await readJson<Record<string, unknown>>(req);
  const title = str(b?.title, 120);
  const message = str(b?.message, 1000);
  if (!title) return fail("title_required", "Give the incident a title.");
  if (!message) return fail("message_required", "Say what is happening.");
  const impact = isImpact(b?.impact) ? b!.impact : "minor";
  const status = isIncidentStatus(b?.status) ? b!.status : "investigating";
  const services = Array.isArray(b?.services) ? (b!.services as unknown[]).filter((s): s is string => typeof s === "string" && PROBES.some((p) => p.id === s)) : [];
  const incident = await createIncident({ title, impact, status, services, message, showBanner: b?.showBanner === true, by: g.ctx.email });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "ops.incident.create",
    targetType: "incident",
    targetId: incident.id,
    targetLabel: title,
    after: { impact, status, services, showBanner: incident.showBanner, banner: incident.banner },
  });
  return NextResponse.json({ ok: true, incident }, { status: 201 });
}

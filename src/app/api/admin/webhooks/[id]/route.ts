// /api/admin/webhooks/[id]
//
// GET    (integrations:write, no fresh code to look)  the endpoint and its deliveries
// PATCH  (integrations:write + fresh code)  { url?, description?, events?, enabled? }
// DELETE (integrations:write + fresh code)

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import {
  deleteEndpoint,
  getEndpoint,
  isWebhookEvent,
  listDeliveries,
  publicEndpoint,
  saveEndpoint,
  webhookUrlProblem,
  type WebhookEvent,
} from "@/lib/platform/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

const shown = (e: { url: string; description: string; events: string[]; enabled: boolean }) => ({
  url: e.url,
  description: e.description,
  events: e.events,
  enabled: e.enabled,
});

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "integrations:write", { readOnly: true });
  if (!g.ok) return g.response;
  const e = await getEndpoint(params.id);
  if (!e) return fail("not_found", "No such webhook.", 404);
  return NextResponse.json({ ok: true, endpoint: publicEndpoint(e), deliveries: await listDeliveries(e.id, 100) });
}

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  const e = await getEndpoint(params.id);
  if (!e) return fail("not_found", "No such webhook.", 404);
  const body = await readJson<{ url?: unknown; description?: unknown; events?: unknown; enabled?: unknown }>(req);
  const before = shown(e);
  if (body?.url !== undefined) {
    const url = str(body.url, 500);
    const problem = webhookUrlProblem(url);
    if (problem) return fail("invalid_url", problem);
    e.url = url;
  }
  if (body?.description !== undefined) e.description = str(body.description, 200);
  if (body?.events !== undefined) {
    const events = Array.isArray(body.events) ? [...new Set(body.events.filter(isWebhookEvent))] : [];
    if (!events.length) return fail("events_required", "Choose at least one event to send.");
    e.events = events as WebhookEvent[];
  }
  if (body?.enabled !== undefined) e.enabled = body.enabled === true;
  await saveEndpoint(e);
  const changes = diff(before, shown(e));
  await recordAdminAction(actorOf(g.ctx), req, { action: "webhook.update", targetType: "webhook", targetId: e.id, targetLabel: e.url, ...changes });
  return NextResponse.json({ ok: true, endpoint: publicEndpoint(e) });
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  const e = await getEndpoint(params.id);
  if (!e) return fail("not_found", "No such webhook.", 404);
  await deleteEndpoint(e.id);
  await recordAdminAction(actorOf(g.ctx), req, { action: "webhook.delete", targetType: "webhook", targetId: e.id, targetLabel: e.url, before: shown(e) });
  return NextResponse.json({ ok: true });
}

// /api/admin/webhooks — the platform's own outgoing webhooks.
//
// GET  (integrations:write, no fresh code to look)  endpoints (secrets as fingerprints) and recent deliveries
// POST (integrations:write + fresh code)  { url, description?, events[] } -> the signing secret, shown this once

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { fingerprint } from "@/lib/platform/integrations";
import {
  WEBHOOK_EVENTS,
  createEndpoint,
  isWebhookEvent,
  listDeliveries,
  listEndpoints,
  publicEndpoint,
  webhookUrlProblem,
  type WebhookEvent,
} from "@/lib/platform/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "integrations:write", { readOnly: true });
  if (!g.ok) return g.response;
  const [endpoints, deliveries] = await Promise.all([listEndpoints(), listDeliveries(undefined, 100)]);
  return NextResponse.json({ ok: true, events: WEBHOOK_EVENTS, endpoints: endpoints.map((e) => publicEndpoint(e)), deliveries });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  const body = await readJson<{ url?: unknown; description?: unknown; events?: unknown }>(req);
  const url = str(body?.url, 500);
  const problem = webhookUrlProblem(url);
  if (problem) return fail("invalid_url", problem);
  const events = Array.isArray(body?.events) ? [...new Set(body!.events.filter(isWebhookEvent))] : [];
  if (!events.length) return fail("events_required", "Choose at least one event to send.");
  if ((await listEndpoints()).length >= 20) return fail("too_many", "At most 20 webhook endpoints.", 409);

  const { endpoint, secret } = await createEndpoint({ url, description: str(body?.description, 200), events: events as WebhookEvent[], createdBy: g.ctx.email });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "webhook.create",
    targetType: "webhook",
    targetId: endpoint.id,
    targetLabel: url,
    after: { url, events, secretFingerprint: fingerprint(secret) },
  });
  return NextResponse.json({ ok: true, endpoint: publicEndpoint(endpoint), secret }, { status: 201 });
}

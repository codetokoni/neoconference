// POST /api/admin/webhooks/[id]/test (integrations:write + fresh code)
// Sends a signed "webhook.test" delivery now and returns how it went.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { emitPlatformEvent, getEndpoint } from "@/lib/platform/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  const e = await getEndpoint(params.id);
  if (!e) return fail("not_found", "No such webhook.", 404);
  const [delivery] = await emitPlatformEvent("webhook.test", { message: "A test delivery from the admin area.", sentBy: g.ctx.email }, e.id);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "webhook.test",
    targetType: "webhook",
    targetId: e.id,
    targetLabel: e.url,
    after: { ok: delivery?.ok ?? false, status: delivery?.status ?? null },
    outcome: delivery?.ok ? "ok" : "failed",
  });
  return NextResponse.json({ ok: true, delivery });
}

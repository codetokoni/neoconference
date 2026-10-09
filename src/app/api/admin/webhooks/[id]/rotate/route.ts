// POST /api/admin/webhooks/[id]/rotate (integrations:write + fresh code)
// { graceHours?: number (0–168, default 24) }
//
// A new signing secret, shown this once. The old one keeps signing every
// delivery alongside it until the grace period ends, so the receiver can
// switch over without missing anything.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { fingerprint } from "@/lib/platform/integrations";
import { DEFAULT_GRACE_HOURS, MAX_GRACE_HOURS, publicEndpoint, rotateSecret } from "@/lib/platform/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  const body = await readJson<{ graceHours?: unknown }>(req);
  const grace = body?.graceHours === undefined ? DEFAULT_GRACE_HOURS : Number(body.graceHours);
  if (!Number.isFinite(grace) || grace < 0 || grace > MAX_GRACE_HOURS) {
    return fail("invalid_grace", `The grace period is 0 to ${MAX_GRACE_HOURS} hours.`);
  }
  const r = await rotateSecret(params.id, grace);
  if (!r) return fail("not_found", "No such webhook.", 404);
  const after = publicEndpoint(r.endpoint);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "webhook.rotate_secret",
    targetType: "webhook",
    targetId: r.endpoint.id,
    targetLabel: r.endpoint.url,
    before: { secrets: r.before.secrets },
    after: { secrets: after.secrets, graceHours: grace, newSecretFingerprint: fingerprint(r.secret) },
  });
  return NextResponse.json({ ok: true, endpoint: after, secret: r.secret, graceHours: grace });
}

// DELETE /api/admin/api-keys/[id] (integrations:write + fresh code)
// Revoke a developer API key: every /api/v1 call with it fails from now on.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { keyOwner, revokeApiKey } from "@/lib/platform/apiKeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  const owner = await keyOwner(params.id);
  const before = await revokeApiKey(params.id, g.ctx.email);
  if (!before) return fail("not_found", "No such API key.", 404);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "api_key.revoke",
    targetType: "api_key",
    targetId: params.id,
    targetLabel: `${before.maskedKey} (${before.name})`,
    before: { revoked: before.revoked, owner },
    after: { revoked: true },
  });
  return NextResponse.json({ ok: true, id: params.id, revoked: true });
}

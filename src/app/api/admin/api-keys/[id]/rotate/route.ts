// POST /api/admin/api-keys/[id]/rotate (integrations:write + fresh code)
//
// For a key that may have leaked: revokes it at once and makes a new key
// for the same account with the same name. The new key is returned this
// once, for the administrator to hand to the account's owner over a safe
// channel; the owner also sees it (masked) in their developer dashboard.
// The audit records only masked keys.

import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { currentPlan } from "@/lib/apiAuth";
import { keyOwner, mintApiKey, revokeApiKey, type KeyMeta } from "@/lib/platform/apiKeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  const meta = await kv.get<KeyMeta>(`apikey:meta:${params.id}`);
  const owner = await keyOwner(params.id);
  if (!meta || !owner) return fail("not_found", "No such API key.", 404);
  if (meta.revoked) return fail("already_revoked", "This key is already revoked; the account can make a new one.", 409);

  const { meta: fresh, raw } = await mintApiKey({ userId: owner, name: meta.name, plan: await currentPlan(owner), rotatedFrom: meta.id });
  await revokeApiKey(meta.id, g.ctx.email);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "api_key.rotate",
    targetType: "api_key",
    targetId: meta.id,
    targetLabel: `${meta.maskedKey} (${meta.name})`,
    before: { id: meta.id, maskedKey: meta.maskedKey, revoked: false },
    after: { revokedId: meta.id, newId: fresh.id, newMaskedKey: fresh.maskedKey, owner },
  });
  return NextResponse.json({ ok: true, revokedId: meta.id, key: { id: fresh.id, name: fresh.name, maskedKey: fresh.maskedKey }, secret: raw }, { status: 201 });
}

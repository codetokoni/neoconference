// GET  /api/admin/partners (integrations:write, read-only): every partner
//      zone integration, with its active key and zone counts.
// POST /api/admin/partners (integrations:write + fresh code): make one.
//      Answers its first secret key once; only its hash is kept.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { readJson } from "@/lib/admin/http";
import { adminFail, readCreate } from "@/lib/partners/admin";
import { createIntegration, listIntegrations, listPartnerKeys, listZones, mintPartnerKey } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "integrations:write", { readOnly: true });
  if (!g.ok) return g.response;
  try {
    const all = await listIntegrations();
    const integrations = await Promise.all(
      all.map(async (i) => {
        const [keys, zones] = await Promise.all([listPartnerKeys(i.id), listZones(i.id)]);
        return { ...i, activeKeys: keys.filter((k) => !k.revokedAt).length, zones: zones.length };
      }),
    );
    return NextResponse.json({ ok: true, integrations });
  } catch (e) {
    return adminFail(e);
  }
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "integrations:write");
  if (!g.ok) return g.response;
  try {
    const input = await readCreate((await readJson(req)) ?? {});
    const integration = await createIntegration({ ...input, by: g.ctx.email });
    const { meta, raw } = await mintPartnerKey(integration.id, g.ctx.email);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "partner.create",
      targetType: "partner_integration",
      targetId: integration.id,
      targetLabel: integration.name,
      after: {
        owner: integration.ownerEmail,
        origins: integration.origins,
        autoCreateZones: integration.autoCreateZones,
        guestAccess: integration.guestAccess,
        titleTemplate: integration.titleTemplate,
        key: meta.masked,
      },
    });
    return NextResponse.json({ ok: true, integration, key: meta, secret: raw }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return adminFail(e);
  }
}

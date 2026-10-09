// /api/admin/comms/templates/[id]/revert — go back to an earlier version (notifications:send).
//
// POST { version }   0 = the built-in default; otherwise a version from the
//                    history, saved again as a new version.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { getTemplate, revertTemplate } from "@/lib/comms/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const t = await getTemplate(params.id);
  if (!t) return fail("not_found", "That template was not found.", 404);
  const body = await readJson<{ version?: unknown }>(req);
  const version = body?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return fail("invalid_version", "Choose a version.");
  const r = await revertTemplate(t.def.id, version, actorOf(g.ctx));
  if (!r) return fail("not_found", "That version was not found.", 404);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "template.revert",
    targetType: "template",
    targetId: t.def.id,
    targetLabel: t.def.name,
    before: r.before,
    after: r.after,
    note: version === 0 ? "Back to the built-in default." : `Restored version ${version}.`,
  });
  return NextResponse.json({ ok: true, active: r.after });
}

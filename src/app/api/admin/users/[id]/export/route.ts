// /api/admin/users/[id]/export — a copy of one account's data. data:export.
//
// GET   the account's recent exports
// POST  start one (then advance it with POST /api/admin/data/exports/<id>)
//
// The owner's data is the owner's to export (refused here like every
// action on the owner's account); an administrator exports their own data
// from their account page, not from here.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { loadTargetUser, targetGuard } from "@/lib/admin/users";
import { listExports, publicExport, startExport } from "@/lib/dataGov/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "data:export");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  // Exports administrators made; the person's own stay theirs.
  return NextResponse.json({ items: (await listExports(t.user.id)).filter((j) => j.by !== "self").map(publicExport) });
}

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "data:export");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  const r = await startExport(t.user.id, g.ctx.userId);
  if ("refused" in r) {
    const msg =
      r.refused === "r2_not_configured" ? "File storage (R2) is not configured, so an export cannot be stored." : "An export for this account is already being prepared.";
    return fail(r.refused, msg, r.refused === "r2_not_configured" ? 503 : 409);
  }
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "data.export.start",
    targetType: "user",
    targetId: t.user.id,
    after: { exportId: r.job.id },
  });
  return NextResponse.json({ ok: true, export: publicExport(r.job) });
}

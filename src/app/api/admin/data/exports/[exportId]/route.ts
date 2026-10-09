// /api/admin/data/exports/[exportId] — an export an administrator started.
// data:export.
//
// POST  advance it (runs sections for a few seconds; call until "ready")
// GET   ?download=1 -> a signed link valid for 5 minutes (audited)

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { advanceExport, downloadLink, getExport, publicExport, DOWNLOAD_LINK_S } from "@/lib/dataGov/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { exportId: string } };

async function load(id: string) {
  const job = await getExport(id);
  // Only exports administrators started; a person's own exports stay theirs.
  return job && job.by !== "self" ? job : null;
}

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "data:export");
  if (!g.ok) return g.response;
  const job = await load(params.exportId);
  if (!job) return fail("not_found", "No such export.", 404);
  const next = await advanceExport(job.id);
  if (next && next.status !== "running" && job.status === "running") {
    await recordAdminAction(actorOf(g.ctx), req, {
      action: next.status === "ready" ? "data.export.ready" : "data.export.failed",
      targetType: "user",
      targetId: job.userId,
      after: { exportId: job.id, sections: next.counts, bytes: next.size ?? null },
      outcome: next.status === "ready" ? "ok" : "failed",
    });
  }
  return NextResponse.json({ ok: true, export: next ? publicExport(next) : null });
}

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "data:export");
  if (!g.ok) return g.response;
  const job = await load(params.exportId);
  if (!job) return fail("not_found", "No such export.", 404);
  if (!new URL(req.url).searchParams.get("download")) return NextResponse.json({ export: publicExport(job) });
  const url = await downloadLink(job);
  if (!url) return fail("not_ready", "The export is not ready yet.", 409);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "data.export.download",
    targetType: "user",
    targetId: job.userId,
    after: { exportId: job.id, linkValidSeconds: DOWNLOAD_LINK_S },
  });
  return NextResponse.json({ url, expiresIn: DOWNLOAD_LINK_S });
}

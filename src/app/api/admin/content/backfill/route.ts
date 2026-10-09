// /api/admin/content/backfill — content:moderate
//
// GET   where the backfill stands (content:read).
// POST  { maxObjects?, maxMs?, restart? } run one slice: list R2 a page at
//       a time and index what is not indexed. Read-only on storage: nothing
//       is moved or deleted. Stops at the object or time cap and keeps a
//       cursor, so pressing it again carries on.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { readJson } from "@/lib/admin/http";
import { backfillState, runBackfill } from "@/lib/content/backfill";
import { isR2Configured } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  return NextResponse.json({ state: await backfillState(), storageConfigured: isR2Configured() });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "content:moderate");
  if (!g.ok) return g.response;
  if (!isR2Configured()) return NextResponse.json({ error: "storage_not_configured", message: "R2 is not configured on this deployment." }, { status: 503 });
  const body = await readJson<{ maxObjects?: unknown; maxMs?: unknown; restart?: unknown }>(req);
  const run = await runBackfill({
    maxObjects: typeof body?.maxObjects === "number" ? body.maxObjects : undefined,
    maxMs: typeof body?.maxMs === "number" ? body.maxMs : undefined,
    restart: body?.restart === true,
  });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "content.backfill.run",
    targetType: "content-index",
    targetLabel: "File index backfill",
    after: { scanned: run.scanned, added: run.added, updated: run.updated, bytes: run.bytes, stoppedBy: run.stoppedBy },
  });
  return NextResponse.json({ ok: true, run });
}

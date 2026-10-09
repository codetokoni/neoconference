// /api/admin/ops/backups
//
// GET  (ops:read)   snapshots (size, keys, checksum, verification), what is
//                   excluded and protected, and the limits
// POST (ops:write)  take a snapshot now — the "ops-backup" job, run by hand
//                   (same lock as the schedule). Audited.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { KEEP_PRE_RESTORE, KEEP_SNAPSHOTS, MAX_KEYS, MAX_RAW_BYTES, RESTORE_PROTECTED, SNAPSHOT_EXCLUDE, listBackups } from "@/lib/ops/backup";
import { runRegisteredJob } from "@/lib/ops/jobRegistry";
import { isR2Configured } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  return NextResponse.json({
    ok: true,
    backups: await listBackups(),
    r2Configured: isR2Configured(),
    canRestore: g.ctx.isOwner,
    config: { exclude: SNAPSHOT_EXCLUDE, protected: RESTORE_PROTECTED, maxKeys: MAX_KEYS, maxRawBytes: MAX_RAW_BYTES, keep: KEEP_SNAPSHOTS, keepPreRestore: KEEP_PRE_RESTORE },
  });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "ops:write");
  if (!g.ok) return g.response;
  if (!isR2Configured()) return fail("r2_not_configured", "Snapshots are stored in R2, which is not configured.", 503);
  const r = await runRegisteredJob("ops-backup", { trigger: "manual", actor: g.ctx.email });
  if (r.locked) return fail("already_running", "A snapshot is being taken now.", 409);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "ops.backup.create",
    targetType: "backup",
    targetLabel: "KV snapshot",
    outcome: r.run?.outcome === "failed" ? "failed" : "ok",
    after: { runId: r.run?.id, outcome: r.run?.outcome, summary: r.run?.summary, error: r.run?.error },
  });
  return NextResponse.json({ ok: r.run?.outcome !== "failed", run: r.run, backups: await listBackups() }, { status: r.run?.outcome === "failed" ? 500 : 200 });
}

// /api/admin/ops/backups/<id>/verify (ops:write) — re-read the snapshot
// from R2 and check its size, checksum, format and key count. Audited.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { verifySnapshot } from "@/lib/ops/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "ops:write");
  if (!g.ok) return g.response;
  const b = await verifySnapshot(params.id);
  if (!b) return fail("not_found", "No such snapshot.", 404);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "ops.backup.verify",
    targetType: "backup",
    targetId: b.id,
    targetLabel: b.r2Key,
    outcome: b.verify?.ok ? "ok" : "failed",
    after: b.verify,
  });
  return NextResponse.json({ ok: true, backup: b });
}

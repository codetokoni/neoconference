// GET /api/admin/audit/integrity — every audit entry ever numbered should
// still be in the log. Missing numbers mean entries were removed outside the
// app (directly in the database).

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { checkAuditIntegrity } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "audit:read");
  if (!g.ok) return g.response;
  const r = await checkAuditIntegrity();
  return NextResponse.json({ ok: true, intact: r.missing.length === 0, ...r });
}

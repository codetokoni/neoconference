// src/app/api/admin/audit-log/route.ts
//
// GET — return the most recent authz decisions from the persistent log.
//
// Query: ?limit=<n>  (1–5000, default 200)
//
// Platform-admin only. This is the queryable half of FRS §12.4 — the write
// half lives in authz.ts recordDecision().

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { listRecentAuditEntries } from "@/lib/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "audit:read");
  if (!g.ok) return g.response;

  const raw = new URL(req.url).searchParams.get("limit");
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 5000) : 200;

  const entries = await listRecentAuditEntries(limit);
  return NextResponse.json({ ok: true, entries });
}

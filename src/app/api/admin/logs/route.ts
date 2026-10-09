// GET /api/admin/logs — one search over the activity log, the admin audit
// and the meeting permission log (analytics:read; the admin audit also needs
// audit:read and is left out without it).
//
// Query: source=all|activity|admin|meeting, user, type (prefix), severity,
// q (any text), from, to (YYYY-MM-DD in `tz`), tz, limit, offset,
// format=csv|xlsx (also needs reports:export; up to 5000 rows).

import { NextResponse } from "next/server";
import { can, requireAdmin } from "@/lib/admin/context";
import { LOG_SOURCES, searchLogs, type LogSource } from "@/lib/admin/logs";
import { periodFromQuery } from "@/lib/activityReports";
import { csvResponse, xlsxResponse, zonedStamp, type Table } from "@/lib/admin/exportReport";
import type { Severity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const format = q.get("format");
  const exporting = format === "csv" || format === "xlsx";
  const g = await requireAdmin(req, exporting ? ["analytics:read", "reports:export"] : "analytics:read");
  if (!g.ok) return g.response;

  const p = periodFromQuery(q, 7);
  const asked = q.get("source");
  const allowed = LOG_SOURCES.filter((s) => s !== "admin" || can(g.ctx, "audit:read"));
  const sources: LogSource[] = asked && asked !== "all" ? allowed.filter((s) => s === asked) : allowed;
  const sev = q.get("severity");
  const severity: Severity | undefined = sev === "info" || sev === "warn" || sev === "error" ? sev : undefined;
  const limit = exporting ? 5000 : Math.max(1, Math.min(Number(q.get("limit")) || 50, 200));
  const offset = exporting ? 0 : Math.max(0, Number(q.get("offset")) || 0);

  const result = await searchLogs({
    sources,
    user: q.get("user")?.trim() || undefined,
    type: q.get("type")?.trim() || undefined,
    severity,
    q: q.get("q")?.trim() || undefined,
    from: p.startMs,
    to: p.endMs,
    limit,
    offset,
  });

  if (!exporting) {
    return NextResponse.json({
      ok: true,
      ...result,
      sources,
      adminAuditHidden: !can(g.ctx, "audit:read"),
      period: { from: p.from, to: p.to, tz: p.tz },
    });
  }
  const table: Table = {
    name: "Logs",
    columns: [
      { header: `Time (${p.tz})`, key: "local", width: 20 },
      { header: "Time (UTC)", key: "utc", width: 24 },
      { header: "Log", key: "source" },
      { header: "Event", key: "type", width: 24 },
      { header: "Severity", key: "severity" },
      { header: "User", key: "user", width: 32 },
      { header: "Summary", key: "summary", width: 50 },
      { header: "Details", key: "details", width: 60 },
    ],
    rows: result.items.map((r) => ({ ...r, local: zonedStamp(r.ts, p.tz), utc: new Date(r.ts).toISOString() })),
  };
  const base = `neoconference-logs-${p.from}-to-${p.to}`;
  return format === "xlsx" ? xlsxResponse([table], base) : csvResponse(table, base);
}

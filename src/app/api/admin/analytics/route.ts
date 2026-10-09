// GET /api/admin/analytics — platform adoption, retention, conversion,
// features and consumption for a period, compared with the period before
// (analytics:read).
//
// Query: from, to (YYYY-MM-DD in `tz`), tz (IANA; default UTC),
// format=csv|xlsx (also needs reports:export) with report=summary|daily|
// features|retention|accounts|plans for CSV (Excel has every report).

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { REPORTS, analyticsTables, buildAnalytics, type ReportName } from "@/lib/admin/analytics";
import { periodFromQuery } from "@/lib/activityReports";
import { csvResponse, xlsxResponse } from "@/lib/admin/exportReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  const exporting = format === "csv" || format === "xlsx";
  const g = await requireAdmin(req, exporting ? ["analytics:read", "reports:export"] : "analytics:read");
  if (!g.ok) return g.response;
  const p = periodFromQuery(url.searchParams, 30);
  const report = await buildAnalytics(p);
  if (!exporting) return NextResponse.json({ ok: true, ...report });

  const tables = analyticsTables(report);
  const base = `neoconference-analytics-${p.from}-to-${p.to}`;
  if (format === "xlsx") return xlsxResponse(REPORTS.map((k) => tables[k]), base);
  const which = (REPORTS as readonly string[]).includes(url.searchParams.get("report") ?? "")
    ? (url.searchParams.get("report") as ReportName)
    : "summary";
  return csvResponse(tables[which], `${base}-${which}`);
}

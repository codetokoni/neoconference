// src/app/api/groups/[id]/reports/export/route.ts
//
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD — one spreadsheet across a date range
// (UTC days, inclusive): one row per person per meeting, the same columns as
// a single meeting's export plus the meeting's date. group:reports:export
// (Host and up). At most 200 meetings.

import { NextResponse } from "next/server";
import { parseDay, reportsInRange } from "@/lib/groupReports";
import { fileSafe, rangeWorkbook } from "@/lib/groupReportXlsx";
import { invalidBody, requireGroupPermission } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:reports:export");
  if (!gate.ok) return gate.response;

  const q = new URL(req.url).searchParams;
  const from = parseDay(q.get("from"));
  const to = parseDay(q.get("to"), true);
  if (!from || !to || to < from) return invalidBody("invalid_date");

  const reports = await reportsInRange(id, gate.member.userId, from, to);
  const buffer = await rangeWorkbook(reports);
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${fileSafe(gate.group.name)}-${q.get("from")}-to-${q.get("to")}.xlsx"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}

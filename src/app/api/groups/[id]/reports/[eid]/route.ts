// src/app/api/groups/[id]/reports/[eid]/route.ts
//
// GET                 one meeting's full report (group:reports:view, Moderator and up)
// GET ?format=xlsx    the same as a spreadsheet: Summary + Attendance
//                     (group:reports:export, Host and up)
// A private call's report is only for the people in it; for anyone else, and
// for a meeting of another group, 404.

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { getMeetingReport, reportVisible } from "@/lib/groupReports";
import { fileSafe, meetingWorkbook } from "@/lib/groupReportXlsx";
import { requireGroupPermission } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params;
  const xlsx = new URL(req.url).searchParams.get("format") === "xlsx";
  const gate = await requireGroupPermission(id, xlsx ? "group:reports:export" : "group:reports:view");
  if (!gate.ok) return gate.response;

  const ev = await eventStore.byId(eid);
  if (!(await reportVisible(ev, id, gate.member.userId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const report = await getMeetingReport(eid);
  if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!xlsx) return NextResponse.json({ report }, { headers: { "cache-control": "no-store" } });

  const buffer = await meetingWorkbook(report);
  const day = (report.actualStart ?? report.scheduledStart ?? "").slice(0, 10);
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="report-${fileSafe(report.title)}-${day}.xlsx"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}

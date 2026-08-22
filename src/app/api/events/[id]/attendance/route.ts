// src/app/api/events/[id]/attendance/route.ts
//
// GET — download the attendance report for an event as an XLSX file.
//
// Path param: id or slug (byId ?? bySlug fallthrough).
//
// Authorization: transcript:read (RANK.host). Same rank as the transcript
// export because both are post-meeting artifacts owned by the meeting host.
//
// FRS §4 columns: Full Name, Username, Email, Meeting Title, Joined Date,
// Joined Time, Left Time, Time Zone, Attendance Duration, Repeat Attendance,
// Number of Entries, Role, Attendance Status.

import { NextResponse, type NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import { fetchAttendanceReport } from "@/lib/attendance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const event = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!event) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const gate = await authorize(event, "transcript:read");
  if (!gate.ok) return gate.response;

  const rows = await fetchAttendanceReport(event);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NeoConference";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Attendance");
  sheet.columns = [
    { header: "Full Name", key: "fullName", width: 24 },
    { header: "Username", key: "username", width: 20 },
    { header: "Email", key: "email", width: 30 },
    { header: "Meeting Title", key: "meetingTitle", width: 28 },
    { header: "Joined Date", key: "joinedDate", width: 14 },
    { header: "Joined Time", key: "joinedTime", width: 14 },
    { header: "Left Time", key: "leftTime", width: 14 },
    { header: "Time Zone", key: "timeZone", width: 10 },
    { header: "Attendance Duration", key: "attendanceDuration", width: 18 },
    { header: "Repeat Attendance", key: "repeatAttendance", width: 16 },
    { header: "Number of Entries", key: "numberOfEntries", width: 16 },
    { header: "Role", key: "role", width: 12 },
    { header: "Attendance Status", key: "attendanceStatus", width: 16 },
    { header: "Inactivity Warnings", key: "inactivityWarnings", width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };

  for (const row of rows) {
    sheet.addRow({
      fullName: row.fullName,
      username: row.username,
      email: row.email,
      meetingTitle: row.meetingTitle,
      joinedDate: row.joinedDate,
      joinedTime: row.joinedTime,
      leftTime: row.leftTime,
      timeZone: row.timeZone,
      attendanceDuration: row.attendanceDuration,
      repeatAttendance: row.repeatAttendance ? "Yes" : "No",
      numberOfEntries: row.numberOfEntries,
      role: row.role,
      attendanceStatus: row.attendanceStatus,
      inactivityWarnings: row.inactivityWarnings,
    });
  }

  // Sessions sheet: one row per individual join/leave interval — spec asks
  // for both the combined summary AND the underlying individual records.
  const sessions = workbook.addWorksheet("Sessions");
  sessions.columns = [
    { header: "Full Name", key: "fullName", width: 24 },
    { header: "Username", key: "username", width: 20 },
    { header: "Email", key: "email", width: 30 },
    { header: "Joined At (UTC)", key: "joinedAt", width: 22 },
    { header: "Left At (UTC)", key: "leftAt", width: 22 },
    { header: "Duration", key: "duration", width: 14 },
  ];
  sessions.getRow(1).font = { bold: true };

  for (const row of rows) {
    for (const iv of row.intervals) {
      const joinedIso = new Date(iv.joinedAt).toISOString();
      const leftIso = iv.leftAt ? new Date(iv.leftAt).toISOString() : "";
      const durationMs = iv.leftAt ? Math.max(0, iv.leftAt - iv.joinedAt) : 0;
      const durationLabel = formatDurationCell(durationMs);
      sessions.addRow({
        fullName: row.fullName,
        username: row.username,
        email: row.email,
        joinedAt: joinedIso,
        leftAt: leftIso,
        duration: durationLabel,
      });
    }
  }

  const buffer = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
  const safeSlug = (event.slug || event.id).replace(/[^a-z0-9-]+/gi, "-");
  const filename = `attendance-${safeSlug}.xlsx`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}

function formatDurationCell(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

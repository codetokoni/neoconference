// src/lib/groupReportXlsx.ts
//
// Group meeting reports as spreadsheets. The attendance sheet uses the same
// FRS §4 columns as a meeting's own attendance export (ATTENDANCE_COLUMNS in
// attendance.ts), followed by Invited, Status, Call attempts and Missed calls.

import ExcelJS from "exceljs";
import { ATTENDANCE_COLUMNS, attendanceRowCells } from "@/lib/attendance";
import type { MeetingReport, ReportParticipant } from "@/lib/groupReports";

const EXTRA_COLUMNS = [
  { header: "Invited", key: "invited", width: 10 },
  { header: "Status", key: "status", width: 12 },
  { header: "Declined", key: "declined", width: 10 },
  { header: "Call attempts", key: "callAttempts", width: 14 },
  { header: "Missed calls", key: "missedCalls", width: 13 },
];

function iso(s: string | null): string {
  return s ? new Date(s).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "";
}

/** One person as a spreadsheet row; someone who never came has the attendance cells empty. */
export function participantCells(report: MeetingReport, p: ReportParticipant): Record<string, string | number> {
  const base = p.row
    ? attendanceRowCells(p.row)
    : {
        fullName: p.name,
        username: p.userId ?? "",
        email: p.email,
        meetingTitle: report.title,
        joinedDate: "",
        joinedTime: "",
        leftTime: "",
        timeZone: "UTC",
        attendanceDuration: "0s",
        repeatAttendance: "No",
        numberOfEntries: 0,
        role: "",
        attendanceStatus: "",
        inactivityWarnings: 0,
      };
  return {
    ...base,
    invited: p.invited ? "Yes" : "No",
    status: p.status === "present" ? "Present" : "Absent",
    declined: p.declined ? "Yes" : "No",
    callAttempts: p.callAttempts,
    missedCalls: p.missedCalls,
  };
}

function bold(sheet: ExcelJS.Worksheet) {
  sheet.getRow(1).font = { bold: true };
}

/** One meeting: Summary, then Attendance. */
export async function meetingWorkbook(report: MeetingReport): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NeoConference";
  wb.created = new Date();

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Item", key: "k", width: 26 },
    { header: "Value", key: "v", width: 60 },
  ];
  bold(summary);
  const s = report.summary;
  const lines: Array<[string, string | number]> = [
    ["Meeting", report.title],
    ["Group", report.group.name],
    ["Host(s)", report.hosts.join(", ")],
    ["Scheduled start", iso(report.scheduledStart)],
    ["Actual start", iso(report.actualStart)],
    ["Actual end", iso(report.actualEnd)],
    ["Duration (minutes)", report.durationMin],
    ["Invited", s.invited],
    ["Attended", s.attended],
    ["Absent", s.absent],
    ["First to join", s.firstToJoin ?? ""],
    ["Last to leave", s.lastToLeave ?? ""],
    ["Call attempts", s.totalCallAttempts],
    ["Missed calls", s.totalMissedCalls],
    ["Chat messages", s.chatMessages],
    ["Recording", s.recordingUrl ?? (s.recorded ? "Recorded (kept by the host)" : "")],
    ["AI summary", s.aiSummary ?? ""],
  ];
  for (const [k, v] of lines) summary.addRow({ k, v });
  summary.getColumn("v").alignment = { wrapText: true, vertical: "top" };

  const sheet = wb.addWorksheet("Attendance");
  sheet.columns = [...ATTENDANCE_COLUMNS.map((c) => ({ ...c })), ...EXTRA_COLUMNS];
  bold(sheet);
  for (const p of report.participants) sheet.addRow(participantCells(report, p));

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** Many meetings: one row per person per meeting. */
export async function rangeWorkbook(reports: MeetingReport[]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NeoConference";
  wb.created = new Date();
  const sheet = wb.addWorksheet("Attendance");
  sheet.columns = [
    { header: "Meeting Date (UTC)", key: "meetingDate", width: 20 },
    ...ATTENDANCE_COLUMNS.map((c) => ({ ...c })),
    ...EXTRA_COLUMNS,
  ];
  bold(sheet);
  for (const r of reports) {
    const date = iso(r.actualStart ?? r.scheduledStart);
    for (const p of r.participants) sheet.addRow({ meetingDate: date, ...participantCells(r, p) });
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** A safe file name part. */
export function fileSafe(s: string): string {
  return s.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
}

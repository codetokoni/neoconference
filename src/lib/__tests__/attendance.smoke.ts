// Run: npx tsx src/lib/__tests__/attendance.smoke.ts
// Pure-module smoke test for the FRS §4 attendance aggregator.
// buildAttendanceReport is pure so we can exercise every branch without
// touching KV or the beacon route.

import assert from "node:assert/strict";
import { buildAttendanceReport, type AttendanceEntry } from "../attendance";
import type { NeoEvent } from "@/types/event";

const MEETING: Pick<NeoEvent, "name" | "endedAt"> = {
  name: "Weekly Standup",
  endedAt: new Date("2026-08-21T15:00:00Z").toISOString(),
};

const at = (iso: string): number => Date.parse(iso);

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("  ok  " + name); };

console.log("attendance aggregator");

t("clean join + leave produces one interval", () => {
  const entries: AttendanceEntry[] = [
    { ts: at("2026-08-21T14:00:00Z"), action: "join", userId: "u_a", name: "Ada", role: "cohost", source: "webhook" },
    { ts: at("2026-08-21T14:45:00Z"), action: "leave", userId: "u_a", name: "Ada", role: "cohost", source: "webhook" },
  ];
  const rows = buildAttendanceReport(MEETING, entries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fullName, "Ada");
  assert.equal(rows[0].username, "u_a");
  assert.equal(rows[0].numberOfEntries, 1);
  assert.equal(rows[0].repeatAttendance, false);
  assert.equal(rows[0].attendanceStatus, "left");
  assert.equal(rows[0].meetingTitle, "Weekly Standup");
});

t("multiple entries collapse into one row; count + repeat set correctly", () => {
  const entries: AttendanceEntry[] = [
    { ts: at("2026-08-21T14:00:00Z"), action: "join", userId: "u_b", name: "Bob", source: "webhook" },
    { ts: at("2026-08-21T14:10:00Z"), action: "leave", userId: "u_b", name: "Bob", source: "beacon" },
    { ts: at("2026-08-21T14:20:00Z"), action: "join", userId: "u_b", name: "Bob", source: "webhook" },
    { ts: at("2026-08-21T14:55:00Z"), action: "leave", userId: "u_b", name: "Bob", source: "webhook" },
  ];
  const rows = buildAttendanceReport(MEETING, entries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].numberOfEntries, 2);
  assert.equal(rows[0].repeatAttendance, true);
  assert.equal(rows[0].attendanceStatus, "left");
});

t("dangling join at end closes at event.endedAt with 'disconnected' status", () => {
  const entries: AttendanceEntry[] = [
    { ts: at("2026-08-21T14:30:00Z"), action: "join", userId: "u_c", name: "Cara", source: "beacon" },
  ];
  const rows = buildAttendanceReport(MEETING, entries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].numberOfEntries, 1);
  assert.equal(rows[0].intervals[0].leftAt, at(MEETING.endedAt!));
  assert.equal(rows[0].attendanceStatus, "disconnected");
});

t("inactivity events count toward inactivityWarnings without breaking the join/leave chain", () => {
  const entries: AttendanceEntry[] = [
    { ts: at("2026-08-21T14:00:00Z"), action: "join", userId: "u_d", name: "Dee", source: "beacon" },
    { ts: at("2026-08-21T14:05:00Z"), action: "inactive", userId: "u_d", name: "Dee", source: "beacon" },
    { ts: at("2026-08-21T14:15:00Z"), action: "inactive", userId: "u_d", name: "Dee", source: "beacon" },
    { ts: at("2026-08-21T14:30:00Z"), action: "leave", userId: "u_d", name: "Dee", source: "beacon" },
  ];
  const rows = buildAttendanceReport(MEETING, entries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inactivityWarnings, 2);
  assert.equal(rows[0].numberOfEntries, 1);
  assert.equal(rows[0].attendanceStatus, "left");
});

t("second join without an intervening leave still records two entries", () => {
  const entries: AttendanceEntry[] = [
    { ts: at("2026-08-21T14:00:00Z"), action: "join", userId: "u_e", name: "Eli", source: "beacon" },
    { ts: at("2026-08-21T14:20:00Z"), action: "join", userId: "u_e", name: "Eli", source: "beacon" },
    { ts: at("2026-08-21T14:45:00Z"), action: "leave", userId: "u_e", name: "Eli", source: "beacon" },
  ];
  const rows = buildAttendanceReport(MEETING, entries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].numberOfEntries, 2);
  assert.equal(rows[0].repeatAttendance, true);
});

t("participants sort by earliest first-join", () => {
  const entries: AttendanceEntry[] = [
    { ts: at("2026-08-21T14:30:00Z"), action: "join", userId: "u_late", name: "Late", source: "beacon" },
    { ts: at("2026-08-21T14:00:00Z"), action: "join", userId: "u_early", name: "Early", source: "beacon" },
  ];
  const rows = buildAttendanceReport(MEETING, entries);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fullName, "Early");
  assert.equal(rows[1].fullName, "Late");
});

t("later entries override name/email/role when the earlier row missed them", () => {
  const entries: AttendanceEntry[] = [
    { ts: at("2026-08-21T14:00:00Z"), action: "join", userId: "u_f", name: "", role: "", source: "webhook" },
    { ts: at("2026-08-21T14:15:00Z"), action: "leave", userId: "u_f", name: "Faye", role: "cohost", email: "faye@example.com", source: "beacon" },
  ];
  const rows = buildAttendanceReport(MEETING, entries);
  assert.equal(rows[0].fullName, "Faye");
  assert.equal(rows[0].email, "faye@example.com");
  assert.equal(rows[0].role, "cohost");
});

console.log(`\n${n} checks passed`);

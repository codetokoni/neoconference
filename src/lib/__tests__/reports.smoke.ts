// Run: npx tsx src/lib/__tests__/reports.smoke.ts
// Meeting reports against the in-memory fallback: who came, who didn't, the
// calling, a removed member's history, who may see or export, My meeting
// reports, and the spreadsheets.
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import type { MeetingRole } from "@/lib/permissions";
import {
  createGroup, setRole, getMember, getGroup, removeMember, decideGroupAccess, updateGroup,
} from "@/lib/groupStore";
import { createGroupMeetings, cleanMeetingFields, type CreateMeetingDeps } from "@/lib/groupMeetings";
import { ringAttempt, respondToRing, __setKingsChatSender } from "@/lib/ringEngine";
import { recordAttendance, ATTENDANCE_COLUMNS } from "@/lib/attendance";
import { eventStore } from "@/lib/eventStore";
import { assignMeetingRole } from "@/lib/meeting-roles";
import type { NeoEvent } from "@/types/event";
import {
  buildMeetingReport, getMeetingReport, listGroupReports, listMyReports, myMeetingDetail, reportsInRange,
  missedCallsOf, __setReportDeps,
} from "@/lib/groupReports";
import { meetingWorkbook, rangeWorkbook } from "@/lib/groupReportXlsx";

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
__setKingsChatSender(async () => "unavailable");
__setReportDeps({ recording: async () => ({ recorded: true, url: "/replay/x" }) });

const MIN = 60_000;
const deps: CreateMeetingDeps = { checkCap: async () => ({ blocked: false, used: 0, cap: 0, plan: "pro" }), incrementCap: async () => {}, applyRecurringRoles: async () => {} };
const actor = (userId: string, role: MeetingRole) =>
  ({ userId, emails: [], isPlatformAdmin: false, role, isOwner: role === "owner", reason: "assignment" as const });

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };

/** A meeting that happened: starts at `at`, ends an hour later. */
async function heldMeeting(gid: string, creator: string, at: number, title: string) {
  const group = (await getGroup(gid))!;
  const fields = cleanMeetingFields({ title, scheduledAt: new Date(at).toISOString(), timezone: "UTC" }, "scheduled", at - 5 * MIN);
  const ev = (await createGroupMeetings({ group, creator: (await getMember(gid, creator))!, kind: "scheduled", fields, origin: "https://neo.test" }, deps)).events[0];
  await eventStore.update(ev.id, (p) => ({ ...p, state: "live", startedAt: new Date(at).toISOString() }));
  return ev;
}
async function endMeeting(eid: string, at: number) {
  await eventStore.update(eid, (p) => ({ ...p, state: "ended", endedAt: new Date(at).toISOString() }));
}
const join = (eid: string, userId: string, name: string, ts: number) =>
  recordAttendance(eid, { action: "join", userId, name, email: `${name.toLowerCase()}@example.com`, source: "webhook", ts });
const leave = (eid: string, userId: string, name: string, ts: number) =>
  recordAttendance(eid, { action: "leave", userId, name, email: `${name.toLowerCase()}@example.com`, source: "webhook", ts });

(async () => {
  const g = await createGroup({ name: "Choir" }, { userId: "user_own", name: "Olu", email: "olu@example.com" }, [
    { userId: "user_hst", name: "Hana", email: "hana@example.com" },
    { userId: "user_mod", name: "Musa", email: "musa@example.com" },
    { userId: "user_ada", name: "Ada", email: "ada@example.com" },
    { userId: "user_bo", name: "Bo", email: "bo@example.com" },
    { userId: "user_cy", name: "Cy", email: "cy@example.com" },
  ]);
  await setRole(g.id, "user_hst", "host", actor("user_own", "owner"));
  await setRole(g.id, "user_mod", "moderator", actor("user_own", "owner"));
  await updateGroup(g.id, { settings: { retryIntervalMin: 3, maxAttempts: 5 } }, "user_own");

  const T = Date.now() - 3 * 24 * 60 * MIN;   // three days ago
  const ev = await heldMeeting(g.id, "user_own", T, "Rehearsal");
  // Calling: Ada answers at the second ring; Bo is rung three times and never comes; Cy declines.
  await ringAttempt(ev.id, { now: T });
  await respondToRing(ev.id, "user_cy", "decline", T + MIN);
  await ringAttempt(ev.id, { now: T + 3 * MIN });
  await respondToRing(ev.id, "user_ada", "answer", T + 4 * MIN);
  await ringAttempt(ev.id, { now: T + 6 * MIN });
  // Attendance: the owner all along; Ada joins, drops, rejoins; Hana and Musa come too.
  await join(ev.id, "user_own", "Olu", T);
  await join(ev.id, "user_hst", "Hana", T + MIN);
  await join(ev.id, "user_mod", "Musa", T + 2 * MIN);
  await join(ev.id, "user_ada", "Ada", T + 5 * MIN);
  await leave(ev.id, "user_ada", "Ada", T + 20 * MIN);
  await join(ev.id, "user_ada", "Ada", T + 25 * MIN);
  await leave(ev.id, "user_ada", "Ada", T + 55 * MIN);
  await leave(ev.id, "user_own", "Olu", T + 60 * MIN);
  await endMeeting(ev.id, T + 60 * MIN);

  console.log("a meeting's report");

  await t("absent = invited minus joined; rejoins counted; first and last", async () => {
    const r = (await buildMeetingReport(ev.id))!;
    const by = Object.fromEntries(r.participants.map((p) => [p.userId, p]));
    assert.equal(r.summary.invited, 6);
    assert.equal(r.summary.attended, 4);
    assert.equal(r.summary.absent, 2);
    assert.deepEqual(r.participants.filter((p) => p.status === "absent").map((p) => p.name).sort(), ["Bo", "Cy"]);
    assert.equal(by.user_ada.entries, 2);
    assert.equal(by.user_ada.attendedMs, 45 * MIN);
    assert.equal(r.summary.firstToJoin, "Olu");
    assert.equal(r.summary.lastToLeave, "Olu");
    assert.equal(r.durationMin, 60);
    assert.equal(r.group?.name, "Choir");
    assert.ok(r.hosts.includes("Olu") && r.hosts.includes("Hana"));
    assert.equal(r.summary.recordingUrl, "/replay/x");
  });

  await t("call attempts and missed calls match the call log", async () => {
    const r = (await buildMeetingReport(ev.id))!;
    const by = Object.fromEntries(r.participants.map((p) => [p.userId, p]));
    assert.equal(by.user_bo.callAttempts, 3);
    assert.equal(by.user_bo.missedCalls, 3);
    assert.equal(by.user_ada.callAttempts, 2);
    assert.equal(by.user_ada.missedCalls, 1);     // answered the second
    assert.equal(by.user_cy.callAttempts, 1);
    assert.equal(by.user_cy.missedCalls, 0);      // declined it, which is not missing it
    assert.equal(by.user_cy.declined, true);
    assert.equal(r.summary.totalCallAttempts, by.user_hst.callAttempts + by.user_mod.callAttempts + 6);
    assert.equal(r.summary.totalMissedCalls, r.participants.reduce((a, p) => a + p.missedCalls, 0));
    assert.equal(missedCallsOf(undefined), 0);
  });

  await t("a member removed from the group is still in the old report, by name", async () => {
    await removeMember(g.id, "user_bo", actor("user_own", "owner"));
    const r = (await buildMeetingReport(ev.id))!;
    const bo = r.participants.find((p) => p.userId === "user_bo")!;
    assert.equal(bo.name, "Bo");
    assert.equal(bo.email, "bo@example.com");
    assert.equal(bo.status, "absent");
    // …and still sees it in their own list.
    const mine = await listMyReports("user_bo", [], []);
    assert.deepEqual(mine.items.map((i) => [i.title, i.status]), [["Rehearsal", "absent"]]);
  });

  await t("a finished meeting's report is cached and served from the cache", async () => {
    const first = (await getMeetingReport(ev.id))!;
    await recordAttendance(ev.id, { action: "join", userId: "user_late", name: "Late", source: "beacon", ts: T + 90 * MIN });
    const again = (await getMeetingReport(ev.id))!;
    assert.equal(again.builtAt, first.builtAt);
    assert.equal(again.summary.attended, first.summary.attended);
  });

  console.log("who may see what");

  await t("a Moderator can view reports but gets 403 on the spreadsheet; a Host can export", async () => {
    const group = (await getGroup(g.id))!;
    const who = (id: string) => ({ userId: id, emails: [], isPlatformAdmin: false });
    const code = async (uid: string, p: "group:reports:view" | "group:reports:export") => {
      const d = decideGroupAccess(who(uid), group, await getMember(g.id, uid), p);
      return d.ok ? 200 : d.status;
    };
    assert.equal(await code("user_mod", "group:reports:view"), 200);
    assert.equal(await code("user_mod", "group:reports:export"), 403);
    assert.equal(await code("user_hst", "group:reports:export"), 200);
    assert.equal(await code("user_ada", "group:reports:view"), 403);
  });

  await t("a Member sees only their own line through My meeting reports", async () => {
    const list = await listMyReports("user_ada", ["ada@example.com"], [g.id]);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].status, "present");
    assert.equal(list.items[0].attendedMs, 45 * MIN);
    const detail = (await myMeetingDetail("user_ada", [], ev.id))!;
    assert.equal(detail.me.name, "Ada");
    assert.equal(detail.me.entries, 2);
    assert.ok(!("participants" in detail));
    assert.equal(await myMeetingDetail("user_stranger", [], ev.id), null);
  });

  await t("the group's report list gives invited / attended / absent, within a date range", async () => {
    const ev2 = await heldMeeting(g.id, "user_hst", T + 24 * 60 * MIN, "Second");
    await join(ev2.id, "user_ada", "Ada", T + 24 * 60 * MIN);
    await endMeeting(ev2.id, T + 25 * 60 * MIN);
    const all = await listGroupReports(g.id, "user_mod", {});
    assert.deepEqual(all.items.map((i) => i.title), ["Second", "Rehearsal"]);
    assert.deepEqual([all.items[1].invited, all.items[1].attended, all.items[1].absent], [6, 4, 2]);
    const day = new Date(T).toISOString().slice(0, 10);
    const from = Date.parse(`${day}T00:00:00.000Z`);
    const only = await listGroupReports(g.id, "user_mod", { from, to: from + 24 * 60 * MIN - 1 });
    assert.deepEqual(only.items.map((i) => i.title), ["Rehearsal"]);
  });

  console.log("spreadsheets");

  await t("a meeting's spreadsheet has Summary and Attendance with the FRS columns plus the extras", async () => {
    const r = (await getMeetingReport(ev.id))!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await meetingWorkbook(r));
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Summary", "Attendance"]);
    const att = wb.getWorksheet("Attendance")!;
    const headers = (att.getRow(1).values as unknown[]).slice(1);
    assert.deepEqual(headers, [...ATTENDANCE_COLUMNS.map((c) => c.header), "Invited", "Status", "Declined", "Call attempts", "Missed calls"]);
    assert.equal(att.rowCount, 1 + r.participants.length);
  });

  await t("a range export's rows match the meetings' own reports", async () => {
    const reports = await reportsInRange(g.id, "user_hst", T - 24 * 60 * MIN, T + 3 * 24 * 60 * MIN);
    assert.deepEqual(reports.map((r) => r.title), ["Second", "Rehearsal"]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await rangeWorkbook(reports));
    const sheet = wb.getWorksheet("Attendance")!;
    const rows: Array<[string, string, string]> = [];
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      const v = row.values as unknown[];
      rows.push([String(v[5]), String(v[2]), String(v[17])]);   // meeting title, name, status
    });
    const expected = reports.flatMap((r) => r.participants.map((p) => [r.title, p.name, p.status === "present" ? "Present" : "Absent"]));
    assert.deepEqual(rows, expected);
  });

  console.log("a meeting outside any group");

  {
    const S = Date.now() - 2 * 24 * 60 * MIN;
    const solo = await eventStore.create({
      id: "ev_solo_report", slug: "solo-report", name: "Bible study", ownerUserId: "user_sol", ownerName: "Sol",
      state: "ended", startedAt: new Date(S).toISOString(), endedAt: new Date(S + 30 * MIN).toISOString(),
      createdAt: new Date(S - MIN).toISOString(), roles: [],
    } as unknown as NeoEvent);
    const sol = { userId: "user_sol", emails: [], isPlatformAdmin: false, role: "owner" as const, isOwner: true, reason: "owner" as const };
    // Shared with: an email (its owner comes from the app, so attendance has
    // no email), a KingsChat handle someone signed in with, and one nobody has.
    await assignMeetingRole(solo.id, "invitee@example.com", "participant", sol);
    await assignMeetingRole(solo.id, { userId: "kc:came" }, "participant", sol);
    await assignMeetingRole(solo.id, { userId: "kc:nobody" }, "participant", sol);
    await recordAttendance(solo.id, { action: "join", userId: "user_sol", name: "Sol", source: "webhook", ts: S });
    await recordAttendance(solo.id, { action: "join", userId: "user_mailer", name: "Mae", source: "webhook", ts: S + MIN });
    await recordAttendance(solo.id, { action: "join", userId: "user_came", name: "Kemi", source: "webhook", ts: S + 2 * MIN });
    await recordAttendance(solo.id, { action: "join", userId: null, name: "Visitor", source: "beacon", ts: S + 3 * MIN });
    await recordAttendance(solo.id, { action: "leave", userId: "user_sol", name: "Sol", source: "webhook", ts: S + 30 * MIN });

    __setReportDeps({
      recording: async () => ({ recorded: false, url: null }),
      emails: async (ids) => new Map(ids.filter((i) => i === "user_mailer").map((i) => [i, "invitee@example.com"])),
      kcUsers: async (handles) => new Map(handles.filter((h) => h === "came").map((h) => [h, "user_came"])),
    });
    const r = (await buildMeetingReport(solo.id))!;
    __setReportDeps({ recording: async () => ({ recorded: true, url: "/replay/x" }) });

    await t("a meeting outside a group has a report: no group, its own kind, its time", () => {
      assert.equal(r.group, null);
      assert.equal(r.kind, "meeting");
      assert.equal(r.durationMin, 30);
      assert.equal(r.summary.recorded, false);
    });

    await t("someone invited by email who came from the app is matched by their account's email, not listed twice", () => {
      const mae = r.participants.filter((p) => p.email === "invitee@example.com");
      assert.equal(mae.length, 1);
      assert.equal(mae[0].userId, "user_mailer");
      assert.equal(mae[0].status, "present");
      assert.equal(mae[0].invited, true);
    });

    await t("a KingsChat invite is matched to whoever signed in with that handle", () => {
      const kemi = r.participants.find((p) => p.userId === "user_came")!;
      assert.equal(kemi.invited, true);
      assert.equal(kemi.status, "present");
    });

    await t("a KingsChat handle nobody has signed in with is invited and absent, with no account", () => {
      const nobody = r.participants.find((p) => p.key === "kc:nobody")!;
      assert.equal(nobody.name, "@nobody");
      assert.equal(nobody.userId, undefined);
      assert.equal(nobody.status, "absent");
      assert.equal(r.summary.invited, 3);
      assert.equal(r.summary.attended, 4);
      assert.equal(r.summary.absent, 1);
    });

    await t("My meeting reports stay group meetings only", async () => {
      assert.equal(await myMeetingDetail("user_came", [], solo.id), null);
    });
  }

  console.log(`\n${n} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

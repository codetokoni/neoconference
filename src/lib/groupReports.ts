// src/lib/groupReports.ts
//
// What happened in a group meeting: who was invited, who came and for how
// long, who never came, and how the calling went.
//
// Everything comes from the meeting's own records — its invitations
// (neo:event:<eid>:invited), call log (neo:event:<eid>:calls) and attendance
// journal — never from who is in the group today, so someone who has since
// left the group is still in the reports of the meetings they were part of.
//
//   neo:report:<eid>   JSON   the built report of a meeting that ended, cached
//
// A finished meeting's report is cached once it has been over for five
// minutes (late leave events have arrived by then); until then it is built
// fresh each time.

import { kv } from "@vercel/kv";
import { eventStore } from "@/lib/eventStore";
import { fetchAttendanceReport, type AttendanceReportRow } from "@/lib/attendance";
import { CLERK_USER_ID, SERVICE_IDENTITY } from "@/lib/groupAttendees";
import { getGroup, listMembers } from "@/lib/groupStore";
import { listGroupMeetings, listInvited, visibleTo } from "@/lib/groupMeetings";
import { addUserMeeting, hasUserMeeting, listUserMeetings } from "@/lib/userMeetings";
import { getCalls, type CallRecord } from "@/lib/ringEngine";
import { getMeetingParticipants } from "@/lib/meeting-roles";
import { chatStore } from "@/lib/chatStore";
import type { NeoEvent } from "@/types/event";

export interface ReportParticipant {
  /** userId, a lowercased email, or "name:<name>" for someone with neither. */
  key: string;
  userId?: string;
  name: string;
  email: string;
  invited: boolean;
  status: "present" | "absent";
  declined: boolean;
  /** Epoch ms of their first join, or null. */
  joinedAt: number | null;
  /** Epoch ms of their last leave, or null. */
  leftAt: number | null;
  attendedMs: number;
  /** Times they joined (rejoins count). */
  entries: number;
  callAttempts: number;
  missedCalls: number;
  /** The FRS §4 row, for the spreadsheet; absent for people who never came. */
  row?: AttendanceReportRow;
}

export interface MeetingReport {
  eventId: string;
  slug: string;
  title: string;
  group: { id: string; name: string };
  kind: "scheduled" | "now" | "call";
  state: NeoEvent["state"];
  hosts: string[];
  /** ISO: when it was meant to start, if it was scheduled. */
  scheduledStart: string | null;
  /** ISO: when it went live, or the first join. */
  actualStart: string | null;
  /** ISO: when it ended, or the last leave. */
  actualEnd: string | null;
  durationMin: number;
  participants: ReportParticipant[];
  summary: {
    invited: number;
    attended: number;
    absent: number;
    firstToJoin: string | null;
    lastToLeave: string | null;
    totalCallAttempts: number;
    totalMissedCalls: number;
    chatMessages: number;
    /** A page members can open, if the meeting was recorded and its replay is open. */
    recordingUrl: string | null;
    /** Recorded at all (the host may keep the only copy). */
    recorded: boolean;
    /** The meeting's AI summary, if the host made one. Never generated here. */
    aiSummary: string | null;
  };
  /** Epoch ms. */
  builtAt: number;
}

/* -------------------------------------------------------------------------- */
/*  Replaceable lookups                                                        */
/* -------------------------------------------------------------------------- */

export interface ReportDeps {
  /** Whether the meeting was recorded, and a page members can open for it. */
  recording(ev: NeoEvent): Promise<{ recorded: boolean; url: string | null }>;
}

const defaultDeps: ReportDeps = {
  async recording(ev) {
    try {
      const { eventReplayVideos, replayOpen } = await import("@/lib/replayRecordings");
      const videos = await eventReplayVideos(ev, 1);
      if (videos.length === 0) return { recorded: false, url: null };
      return { recorded: true, url: replayOpen(ev) ? `/replay/${ev.slug}` : null };
    } catch (err) {
      console.warn("[reports] could not list recordings", err);
      return { recorded: false, url: null };
    }
  },
};
let deps: ReportDeps = defaultDeps;

/** Tests only: replace the recording lookup (null restores the real one). */
export function __setReportDeps(fake: ReportDeps | null): void {
  deps = fake ?? defaultDeps;
}

/* -------------------------------------------------------------------------- */
/*  Cache                                                                      */
/* -------------------------------------------------------------------------- */

const reportKey = (eid: string) => `neo:report:${eid}`;
const CACHE_SECONDS = 400 * 24 * 60 * 60;
const SETTLE_MS = 5 * 60_000;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const mem = new Map<string, MeetingReport>();

async function readCache(eid: string): Promise<MeetingReport | null> {
  if (!isKvConfigured()) return mem.get(eid) ?? null;
  const raw = await kv.get(reportKey(eid));
  if (!raw) return null;
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as MeetingReport;
  } catch {
    return null;
  }
}

async function writeCache(r: MeetingReport): Promise<void> {
  if (!isKvConfigured()) {
    mem.set(r.eventId, r);
    return;
  }
  await kv.set(reportKey(r.eventId), JSON.stringify(r), { ex: CACHE_SECONDS });
}

/** Drop a cached report (when something about the meeting changes). */
export async function forgetReport(eid: string): Promise<void> {
  if (!isKvConfigured()) {
    mem.delete(eid);
    return;
  }
  await kv.del(reportKey(eid));
}

/* -------------------------------------------------------------------------- */
/*  Building                                                                   */
/* -------------------------------------------------------------------------- */

export function isEnded(ev: Pick<NeoEvent, "state">): boolean {
  return ev.state === "ended" || ev.state === "replay";
}

/** Rings someone did not pick up: every ring but the one they answered or declined. */
export function missedCallsOf(c: CallRecord | undefined): number {
  if (!c) return 0;
  const settled = c.status === "joined" || c.status === "answered" || c.status === "declined";
  return Math.max(0, c.attempts - (settled ? 1 : 0));
}

function attendedMsOf(row: AttendanceReportRow, endMs: number): number {
  return row.intervals.reduce((acc, iv) => {
    const end = iv.leftAt ?? (Number.isFinite(endMs) ? endMs : iv.joinedAt);
    return acc + Math.max(0, end - iv.joinedAt);
  }, 0);
}

/** Build a meeting's report from its records. */
export async function buildMeetingReport(eid: string, now: number = Date.now()): Promise<MeetingReport | null> {
  const ev = await eventStore.byId(eid);
  if (!ev?.groupId || !ev.groupMeeting) return null;

  const [group, rows, invited, calls, chat, roles, members, recording] = await Promise.all([
    getGroup(ev.groupId),
    fetchAttendanceReport(ev),
    listInvited(ev.id),
    getCalls(ev.id),
    chatStore.list(ev.id).catch(() => []),
    getMeetingParticipants(ev.id, ev).catch(() => []),
    listMembers(ev.groupId).catch(() => []),
    deps.recording(ev),
  ]);
  const endMs = ev.endedAt ? Date.parse(ev.endedAt) : NaN;
  const memberName = new Map(members.map((m) => [m.userId, m.name]));

  const people = new Map<string, ReportParticipant>();
  const byEmail = new Map<string, string>();

  // Everyone who came.
  for (const row of rows) {
    if (row.username && SERVICE_IDENTITY.test(row.username)) continue;
    const userId = row.username && CLERK_USER_ID.test(row.username) ? row.username : undefined;
    const key = userId ?? (row.email ? row.email.toLowerCase() : `name:${row.fullName.trim().toLowerCase()}`);
    const iv = row.intervals;
    people.set(key, {
      key,
      ...(userId ? { userId } : {}),
      name: row.fullName || memberName.get(userId ?? "") || "Guest",
      email: row.email || "",
      invited: false,
      status: "present",
      declined: false,
      joinedAt: iv.length ? iv[0].joinedAt : null,
      leftAt: iv.reduce<number | null>((acc, x) => (x.leftAt !== null && (acc === null || x.leftAt > acc) ? x.leftAt : acc), null),
      attendedMs: attendedMsOf(row, endMs),
      entries: row.numberOfEntries,
      callAttempts: 0,
      missedCalls: 0,
      row,
    });
    if (row.email) byEmail.set(row.email.toLowerCase(), key);
  }

  // Everyone who was asked to.
  for (const [key, entry] of invited) {
    const isEmail = key.includes("@");
    const existing = people.get(key) ?? (isEmail ? people.get(byEmail.get(key) ?? "") : undefined);
    if (existing) {
      existing.invited = true;
      continue;
    }
    people.set(key, {
      key,
      ...(isEmail ? {} : { userId: key }),
      name: entry.name || memberName.get(key) || (isEmail ? key : "Member"),
      email: entry.email || (isEmail ? key : ""),
      invited: true,
      status: "absent",
      declined: false,
      joinedAt: null,
      leftAt: null,
      attendedMs: 0,
      entries: 0,
      callAttempts: 0,
      missedCalls: 0,
    });
  }

  // How the calling went. Anyone rung was invited.
  for (const [uid, c] of calls) {
    const p = people.get(uid);
    if (!p) continue;
    p.invited = true;
    p.callAttempts = c.attempts;
    p.missedCalls = missedCallsOf(c);
    p.declined = c.status === "declined";
  }

  const participants = Array.from(people.values()).sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "present" ? -1 : 1) ||
      (a.joinedAt ?? Infinity) - (b.joinedAt ?? Infinity) ||
      a.name.localeCompare(b.name)
  );
  const present = participants.filter((p) => p.status === "present");
  const first = present.reduce<ReportParticipant | null>((a, p) => (a === null || (p.joinedAt ?? Infinity) < (a.joinedAt ?? Infinity) ? p : a), null);
  const last = present.reduce<ReportParticipant | null>((a, p) => (p.leftAt !== null && (a === null || p.leftAt > (a.leftAt ?? -Infinity)) ? p : a), null);

  const startMs = ev.startedAt ? Date.parse(ev.startedAt) : first?.joinedAt ?? NaN;
  const finishMs = Number.isFinite(endMs) ? endMs : last?.leftAt ?? NaN;
  const hostIds = roles.filter((r) => r.role === "host" && r.userId).map((r) => r.userId!);
  const nameOf = (uid: string) => people.get(uid)?.name || memberName.get(uid) || null;
  const hosts = Array.from(
    new Set([ev.ownerName || nameOf(ev.ownerUserId) || "Owner", ...hostIds.map(nameOf).filter((n): n is string => Boolean(n))])
  );

  const report: MeetingReport = {
    eventId: ev.id,
    slug: ev.slug,
    title: ev.name,
    group: { id: ev.groupId, name: group?.name ?? "A group that no longer exists" },
    kind: ev.groupMeeting.kind,
    state: ev.state,
    hosts,
    scheduledStart: ev.scheduledAt ?? null,
    actualStart: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    actualEnd: Number.isFinite(finishMs) ? new Date(finishMs).toISOString() : null,
    durationMin: Number.isFinite(startMs) && Number.isFinite(finishMs) ? Math.max(0, Math.round((finishMs - startMs) / 60_000)) : 0,
    participants,
    summary: {
      invited: participants.filter((p) => p.invited).length,
      attended: present.length,
      absent: participants.filter((p) => p.invited && p.status === "absent").length,
      firstToJoin: first?.name ?? null,
      lastToLeave: last?.name ?? null,
      totalCallAttempts: participants.reduce((a, p) => a + p.callAttempts, 0),
      totalMissedCalls: participants.reduce((a, p) => a + p.missedCalls, 0),
      chatMessages: chat.length,
      recordingUrl: recording.url,
      recorded: recording.recorded,
      aiSummary: ev.summary?.text ?? null,
    },
    builtAt: now,
  };

  if (isEnded(ev) && Number.isFinite(endMs) && now - endMs >= SETTLE_MS) await writeCache(report);
  return report;
}

/** A meeting's report: the cached one for a finished meeting, else built now. */
export async function getMeetingReport(eid: string, now: number = Date.now()): Promise<MeetingReport | null> {
  return (await readCache(eid)) ?? buildMeetingReport(eid, now);
}

/** One person's line in a meeting's report, or null if they had no part in it. */
export function ownRow(report: MeetingReport, userId: string, emails: string[] = []): ReportParticipant | null {
  return (
    report.participants.find((p) => p.userId === userId) ??
    report.participants.find((p) => !p.userId && emails.includes(p.email.toLowerCase())) ??
    null
  );
}

/** Start of the meeting, for lists. */
export function reportDate(report: MeetingReport): string {
  return report.actualStart ?? report.scheduledStart ?? new Date(0).toISOString();
}


/** "2026-10-01" as the first (or, with endOfDay, last) ms of that UTC day. */
export function parseDay(v: string | null, endOfDay = false): number | null | undefined {
  if (v === null || v === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return endOfDay ? ms + 24 * 60 * 60_000 - 1 : ms;
}

/* -------------------------------------------------------------------------- */
/*  Lists                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReportListItem {
  eventId: string;
  slug: string;
  title: string;
  kind: MeetingReport["kind"];
  /** ISO start. */
  date: string;
  durationMin: number;
  invited: number;
  attended: number;
  absent: number;
}

function listItem(r: MeetingReport): ReportListItem {
  return {
    eventId: r.eventId,
    slug: r.slug,
    title: r.title,
    kind: r.kind,
    date: reportDate(r),
    durationMin: r.durationMin,
    invited: r.summary.invited,
    attended: r.summary.attended,
    absent: r.summary.absent,
  };
}

/**
 * A group's finished meetings, newest first, a page at a time, optionally
 * between two dates (epoch ms, inclusive). Private calls only for the people
 * in them.
 */
export async function listGroupReports(
  gid: string,
  viewerId: string,
  opts: { cursor?: number; from?: number; to?: number; now?: number } = {}
): Promise<{ items: ReportListItem[]; nextCursor: number | null }> {
  const now = opts.now ?? Date.now();
  const cursor = opts.cursor ?? (opts.to !== undefined ? opts.to + 1 : undefined);
  const page = await listGroupMeetings(gid, viewerId, "past", { ...(cursor !== undefined ? { cursor } : {}), now });
  const from = opts.from ?? -Infinity;
  const inRange = page.items.filter((i) => Date.parse(i.start) >= from);
  const reports = await Promise.all(inRange.map((i) => getMeetingReport(i.id, now)));
  const items = reports.filter((r): r is MeetingReport => r !== null).map(listItem);
  const reachedFrom = page.items.some((i) => Date.parse(i.start) < from);
  return { items, nextCursor: reachedFrom ? null : page.nextCursor };
}

/** Every finished meeting between two dates, for one spreadsheet (at most 200 meetings). */
export async function reportsInRange(
  gid: string,
  viewerId: string,
  from: number,
  to: number,
  now: number = Date.now()
): Promise<MeetingReport[]> {
  const out: MeetingReport[] = [];
  let cursor: number | undefined = to + 1;
  for (let page = 0; page < 10 && cursor !== undefined; page++) {
    const res = await listGroupReports(gid, viewerId, { cursor, from, now });
    for (const item of res.items) {
      const r = await getMeetingReport(item.eventId, now);
      if (r) out.push(r);
    }
    cursor = res.nextCursor ?? undefined;
  }
  return out;
}

/** May this person see this meeting's group report? It must be the group's, and visible to them. */
export async function reportVisible(ev: NeoEvent | null, gid: string, viewerId: string): Promise<boolean> {
  if (!ev || ev.groupId !== gid || !ev.groupMeeting) return false;
  return visibleTo(ev, viewerId);
}

/* -------------------------------------------------------------------------- */
/*  My meeting reports                                                         */
/* -------------------------------------------------------------------------- */

export interface MyMeetingItem {
  eventId: string;
  title: string;
  groupName: string;
  /** ISO start. */
  date: string;
  durationMin: number;
  attendedMs: number;
  status: "present" | "absent";
  declined: boolean;
}

/**
 * Put into someone's list the finished meetings of their groups they were
 * invited to before the list existed. Cheap to repeat: only adds.
 */
async function backfill(uid: string, groupIds: string[], now: number): Promise<void> {
  for (const gid of groupIds) {
    const { items } = await listGroupMeetings(gid, uid, "past", { now });
    for (const item of items) {
      if (await hasUserMeeting(uid, item.id)) continue;
      if ((await listInvited(item.id)).has(uid)) await addUserMeeting(uid, item.id, Date.parse(item.start));
    }
  }
}

/** The signed-in person's finished group meetings, newest first, with their own line only. */
export async function listMyReports(
  uid: string,
  emails: string[],
  groupIds: string[],
  opts: { cursor?: number; now?: number } = {}
): Promise<{ items: MyMeetingItem[]; nextCursor: number | null }> {
  const now = opts.now ?? Date.now();
  if (opts.cursor === undefined) await backfill(uid, groupIds, now);
  const page = await listUserMeetings(uid, { ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}), limit: 20 });
  const items: MyMeetingItem[] = [];
  for (const { eid } of page.eids) {
    const ev = await eventStore.byId(eid);
    if (!ev || !isEnded(ev)) continue;
    const report = await getMeetingReport(eid, now);
    const mine = report && ownRow(report, uid, emails);
    if (!report || !mine) continue;
    items.push({
      eventId: eid,
      title: report.title,
      groupName: report.group.name,
      date: reportDate(report),
      durationMin: report.durationMin,
      attendedMs: mine.attendedMs,
      status: mine.status,
      declined: mine.declined,
    });
  }
  return { items, nextCursor: page.nextCursor };
}

/** One of the person's own meetings in detail, or null if it is not theirs. */
export async function myMeetingDetail(uid: string, emails: string[], eid: string, now: number = Date.now()) {
  const report = await getMeetingReport(eid, now);
  if (!report) return null;
  const mine = ownRow(report, uid, emails);
  if (!mine) return null;
  return {
    eventId: report.eventId,
    title: report.title,
    groupName: report.group.name,
    hosts: report.hosts,
    date: reportDate(report),
    durationMin: report.durationMin,
    state: report.state,
    me: {
      name: mine.name,
      status: mine.status,
      invited: mine.invited,
      declined: mine.declined,
      joinedAt: mine.joinedAt,
      leftAt: mine.leftAt,
      attendedMs: mine.attendedMs,
      entries: mine.entries,
      callAttempts: mine.callAttempts,
      missedCalls: mine.missedCalls,
    },
  };
}

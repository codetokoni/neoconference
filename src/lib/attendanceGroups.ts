// src/lib/attendanceGroups.ts
//
// Attendance by church or group. Asked for in the SA prayer meeting's
// feedback (23 Nov 2026): "a spreadsheet sent after prayer to extract their
// group's people … some handles are hard to identify". Hundreds attend from
// many churches, and almost none are in a NeoLinguaMeet group, so:
//
//   - the meeting's owner lists its churches or groups, each with a leader
//     to send to (a KingsChat handle and/or an email): NeoEvent.attendanceGroups;
//   - everyone picks theirs once, when confirming their full name before
//     joining (the web asks; remembered for that meeting): a choice per
//     person per meeting;
//   - when a session of the meeting ends, its attendance goes out split by
//     group: the owner gets a link to one spreadsheet with a tab per group
//     (and "Not given" for anyone who did not pick), each leader a link to
//     their own group's. Links rather than attachments: KingsChat carries no
//     files, and a link opens on any phone.
//
// A session is sent once (by its start), a few minutes after it ends, by
// the attendance-groups job (late leave events arrive by then).
//
//   neo:event:<id>:attgroups:choice   hash userId → group name (a year)
//   neo:attgroups:pending             zset {eventId,start,end} by end
//   neo:attgroups:sent:<id>:<start>   "1" once sent (60 days)
//   neo:event:<id>:attgroups:sends    list of SentSession, newest first (50)
//   neo:attgroups:dl:<token>          Download (30 days)

import { randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import { kv } from "@/lib/kv";
import { eventStore } from "@/lib/eventStore";
import { buildAttendanceReport, listAttendance, type AttendanceReportRow } from "@/lib/attendance";
import { withUsernames } from "@/lib/attendeeNames";
import { cleanFullName, NAME_NOT_CAPTURED } from "@/lib/attendeeName";
import { cleanContact, kcIdForHandle, type FeedbackContact } from "@/lib/meetingFeedback";
import { sendKcMessage } from "@/lib/kingschat-send";
import { sendMail } from "@/lib/mail";
import { addNotification } from "@/lib/notificationStore";
import { sendPush, topicFor } from "@/lib/pushStore";
import { BRAND, siteOrigin } from "@/lib/brand";
import type { NeoEvent } from "@/types/event";

export const GROUP_NAME_MAX = 80;
export const MAX_GROUPS = 300;
/** The tab for people who did not pick a group. */
export const NOT_GIVEN = "Not given";
/** How long after a session ends it is sent. */
export const SETTLE_MS = 5 * 60_000;
const YEAR_S = 365 * 24 * 60 * 60;
const SENT_S = 60 * 24 * 60 * 60;
const LINK_S = 30 * 24 * 60 * 60;

export interface AttendanceGroup {
  name: string;
  leader?: FeedbackContact;
}

const choiceKey = (eventId: string) => `neo:event:${eventId}:attgroups:choice`;
const PENDING = "neo:attgroups:pending";
const sentKey = (eventId: string, start: number) => `neo:attgroups:sent:${eventId}:${start}`;
const sendsKey = (eventId: string) => `neo:event:${eventId}:attgroups:sends`;
const dlKey = (token: string) => `neo:attgroups:dl:${token}`;

/* ------------------------------ the list ------------------------------- */

/** A group's name as typed, tidied; "" for nothing usable. */
export function cleanGroupName(v: unknown): string {
  return cleanFullName(v).slice(0, GROUP_NAME_MAX).trim();
}

/**
 * The owner's list as sent: [{ name, leader?: { kcHandle?, email? } }].
 * Returns the cleaned list, null to clear, or a reason it cannot be saved.
 */
export function cleanGroups(raw: unknown): AttendanceGroup[] | null | { problem: string } {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return { problem: "Send the churches or groups as a list." };
  if (raw.length > MAX_GROUPS) return { problem: `At most ${MAX_GROUPS} churches or groups.` };
  const out: AttendanceGroup[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const r = (item ?? {}) as { name?: unknown; leader?: unknown };
    const name = cleanGroupName(r.name);
    if (!name) continue;
    if (name.toLowerCase() === NOT_GIVEN.toLowerCase()) return { problem: `"${NOT_GIVEN}" is kept for people who do not pick one.` };
    if (seen.has(name.toLowerCase())) return { problem: `"${name}" is listed twice.` };
    seen.add(name.toLowerCase());
    const g: AttendanceGroup = { name };
    if (r.leader !== undefined && r.leader !== null) {
      const leader = cleanContact(r.leader);
      if (leader === "invalid") return { problem: `The leader for "${name}" is not a KingsChat handle or an email address.` };
      if (leader) g.leader = leader;
    }
    out.push(g);
  }
  return out.length ? out : null;
}

/** The meeting's group names, in the owner's order. */
export function groupNames(ev: Pick<NeoEvent, "attendanceGroups">): string[] {
  return (ev.attendanceGroups?.groups ?? []).map((g) => g.name);
}

/** The listed name a typed choice stands for (case and spacing aside), or "". */
export function matchGroup(ev: Pick<NeoEvent, "attendanceGroups">, typed: unknown): string {
  const t = cleanGroupName(typed).toLowerCase();
  return t ? groupNames(ev).find((n) => n.toLowerCase() === t) ?? "" : "";
}

/* ---------------------------- the choices ------------------------------ */

export async function choiceOf(eventId: string, userId: string): Promise<string> {
  return cleanGroupName(await kv.hget(choiceKey(eventId), userId));
}

export async function setChoice(eventId: string, userId: string, group: string): Promise<void> {
  await kv.hset(choiceKey(eventId), { [userId]: group });
  await kv.expire(choiceKey(eventId), YEAR_S);
}

async function allChoices(eventId: string): Promise<Map<string, string>> {
  const all = ((await kv.hgetall(choiceKey(eventId))) ?? {}) as Record<string, unknown>;
  return new Map(Object.entries(all).map(([u, g]) => [u, cleanGroupName(g)]));
}

/* ----------------------------- a session ------------------------------- */

export interface SessionRow {
  fullName: string;
  username: string;
  email: string;
  firstJoined: string;
  lastLeft: string;
  timeIn: string;
  timesJoined: number;
}

export interface SessionByGroup {
  meeting: string;
  start: number;
  end: number;
  /** Group name → its people (listed groups that nobody picked are empty). */
  groups: Map<string, SessionRow[]>;
  attended: number;
}

/** A session's attendance (joins between `start` and `end`), split by the group each person picked. */
export async function sessionByGroup(ev: NeoEvent, start: number, end: number): Promise<SessionByGroup> {
  const window = (await listAttendance(ev.id)).filter((e) => e.ts >= start - 60_000 && e.ts <= end + SETTLE_MS);
  // Only people who joined in this session: a leave on its own is the end of
  // the session before (two sessions of a permanent room can be minutes apart).
  const who = (e: { userId: string | null; name: string }) => e.userId || `name:${e.name}`;
  const joined = new Set(window.filter((e) => e.action === "join" && e.ts <= end).map(who));
  const entries = window.filter((e) => joined.has(who(e)));
  // Everyone who joined in the session (the journal only has people who did).
  const raw: AttendanceReportRow[] = buildAttendanceReport({ name: ev.name, endedAt: new Date(end).toISOString() }, entries);
  const choices = await allChoices(ev.id);
  const accountOf = raw.map((r) => r.username);
  const named = await withUsernames(raw);
  const groups = new Map<string, SessionRow[]>(groupNames(ev).map((n) => [n, []]));
  named.forEach((r, i) => {
    const picked = choices.get(accountOf[i]) || "";
    const group = groups.has(picked) ? picked : NOT_GIVEN;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({
      fullName: r.fullName || NAME_NOT_CAPTURED,
      username: r.username,
      email: r.email,
      firstJoined: r.joinedTime,
      lastLeft: r.leftTime,
      timeIn: r.attendanceDuration,
      timesJoined: r.numberOfEntries,
    });
  });
  for (const rows of groups.values()) rows.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { meeting: ev.name, start, end, groups, attended: named.length };
}

/** A tab name Excel accepts: 31 characters, none of : \ / ? * [ ], unique. */
function tabName(name: string, used: Set<string>): string {
  const base = name.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Group";
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 31 - ` (${i})`.length)} (${i})`;
  used.add(n.toLowerCase());
  return n;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/**
 * The spreadsheet: a Summary, then a tab per group. `only` keeps one group
 * (a leader's copy, which leaves out email addresses).
 */
export async function sessionWorkbook(s: SessionByGroup, only?: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = BRAND.name;
  wb.created = new Date();
  const groups = only ? [[only, s.groups.get(only) ?? []] as const] : [...s.groups.entries()];
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Item", key: "k", width: 28 },
    { header: "Value", key: "v", width: 48 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.addRow({ k: "Meeting", v: s.meeting });
  summary.addRow({ k: "Date", v: day(s.start) });
  summary.addRow({ k: "Started (UTC)", v: hhmm(s.start) });
  summary.addRow({ k: "Ended (UTC)", v: hhmm(s.end) });
  if (!only) summary.addRow({ k: "Attended", v: s.attended });
  for (const [name, rows] of groups) summary.addRow({ k: name, v: rows.length });
  const used = new Set<string>(["summary"]);
  for (const [name, rows] of groups) {
    const sheet = wb.addWorksheet(tabName(name, used));
    sheet.columns = [
      { header: "Full name", key: "fullName", width: 30 },
      { header: "KingsChat / username", key: "username", width: 24 },
      ...(only ? [] : [{ header: "Email", key: "email", width: 28 }]),
      { header: "First joined (UTC)", key: "firstJoined", width: 18 },
      { header: "Last left (UTC)", key: "lastLeft", width: 16 },
      { header: "Time in the meeting", key: "timeIn", width: 20 },
      { header: "Times joined", key: "timesJoined", width: 13 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const r of rows) sheet.addRow(only ? { ...r, email: undefined } : r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ----------------------------- downloads ------------------------------- */

export interface Download {
  eventId: string;
  start: number;
  end: number;
  /** One group's (a leader's link), or null for every group (the owner's). */
  group: string | null;
}

export async function createDownload(d: Download): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await kv.set(dlKey(token), JSON.stringify(d), { ex: LINK_S });
  return token;
}

export async function readDownload(token: unknown): Promise<Download | null> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const raw = await kv.get(dlKey(token));
  if (!raw) return null;
  const d = (typeof raw === "string" ? JSON.parse(raw) : raw) as Download;
  return d && typeof d.eventId === "string" ? d : null;
}

export const downloadUrl = (token: string) => `${siteOrigin()}/api/attendance-groups/${token}`;

/** The file name for a download. */
export function fileName(meeting: string, start: number, group: string | null): string {
  const safe = (s: string) => s.replace(/[^\p{L}\p{N} _-]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 60) || "meeting";
  return `${safe(meeting)} ${day(start)}${group ? ` - ${safe(group)}` : " - by group"}.xlsx`;
}

/* ------------------------------ sending -------------------------------- */

/** When a session of a meeting with groups ends: send its attendance a few minutes later. */
export async function queueSession(ev: Pick<NeoEvent, "id" | "attendanceGroups" | "startedAt">, end: number): Promise<boolean> {
  const start = Date.parse(ev.startedAt || "");
  if (!groupNames(ev).length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  await kv.zadd(PENDING, { score: end, member: JSON.stringify({ eventId: ev.id, start, end }) });
  return true;
}

export interface SentSession {
  start: number;
  end: number;
  attended: number;
  /** The owner's link (every group). */
  token: string;
  sentAt: number;
  leaders: Array<{ group: string; kc: boolean; email: boolean }>;
}

export async function listSends(eventId: string): Promise<SentSession[]> {
  const raw = ((await kv.lrange(sendsKey(eventId), 0, 49)) ?? []) as unknown[];
  return raw.map((r) => (typeof r === "string" ? JSON.parse(r) : r) as SentSession);
}

export type Senders = {
  kc: (fromClerkId: string, toKcId: string, text: string) => Promise<{ ok: boolean }>;
  mail: (to: string, subject: string, text: string) => Promise<{ ok: boolean }>;
  ownerEmail: (userId: string) => Promise<string>;
};
const realSenders: Senders = {
  kc: (from, to, text) => sendKcMessage(from, to, text),
  mail: (to, subject, text) => sendMail({ to, subject, text }),
  ownerEmail: async (userId) => {
    const { clerkClient } = await import("@clerk/nextjs/server");
    const u = await (await clerkClient()).users.getUser(userId);
    return (u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || "").toLowerCase();
  },
};
let senders = realSenders;
/** Tests: record instead of sending. */
export function __setAttendanceSenders(s: Senders | null) {
  senders = s ?? realSenders;
}

/** Sends one session: the owner's link and each leader's. Once per session. */
export async function sendSession(eventId: string, start: number, end: number, now = Date.now()): Promise<SentSession | null> {
  const ev = await eventStore.byId(eventId);
  if (!ev || !groupNames(ev).length) return null;
  if ((await kv.set(sentKey(eventId, start), "1", { nx: true, ex: SENT_S })) !== "OK") return null;
  const s = await sessionByGroup(ev, start, end);
  const when = `${day(start)}, ${hhmm(start)}–${hhmm(end)} UTC`;
  const token = await createDownload({ eventId, start, end, group: null });
  const sent: SentSession = { start, end, attended: s.attended, token, sentAt: now, leaders: [] };

  // Each leader: their group's people.
  for (const g of ev.attendanceGroups?.groups ?? []) {
    if (!g.leader) continue;
    const count = s.groups.get(g.name)?.length ?? 0;
    const link = downloadUrl(await createDownload({ eventId, start, end, group: g.name }));
    const text = `Attendance for ${g.name}: ${ev.name}, ${when}.\n${count} of your people attended.\n\nSpreadsheet (full names and KingsChat handles): ${link}\n\nThe link works for 30 days.`;
    const r = { group: g.name, kc: false, email: false };
    if (g.leader.kcHandle) {
      const kcId = await kcIdForHandle(g.leader.kcHandle).catch(() => null);
      if (kcId) r.kc = (await senders.kc(ev.ownerUserId, kcId, text).catch(() => ({ ok: false }))).ok;
    }
    if (g.leader.email) r.email = (await senders.mail(g.leader.email, `Attendance for ${g.name}: ${ev.name}`, text).catch(() => ({ ok: false }))).ok;
    sent.leaders.push(r);
  }

  // The owner: every group, in the bell, as a push, and by email.
  const title = `Attendance by group: ${ev.name}`;
  const body = `${s.attended} attended on ${when}. Spreadsheet with a tab per group.`;
  const url = `/dashboard/e/${encodeURIComponent(ev.slug)}#attendance-groups`;
  await addNotification(ev.ownerUserId, { type: "attendance", title, body, url }, now).catch(() => {});
  await sendPush(ev.ownerUserId, { type: "attendance", title, body, url, eventSlug: ev.slug }, { urgency: "normal", topic: topicFor(`attendance:${ev.id}`) }).catch(() => {});
  const ownerEmail = await senders.ownerEmail(ev.ownerUserId).catch(() => "");
  if (ownerEmail) {
    await senders.mail(ownerEmail, title, `${body}\n\nDownload: ${downloadUrl(token)}\n\nEvery session is also on the meeting's page: ${siteOrigin()}${url}`).catch(() => ({ ok: false }));
  }

  await kv.lpush(sendsKey(eventId), JSON.stringify(sent));
  await kv.ltrim(sendsKey(eventId), 0, 49);
  await kv.expire(sendsKey(eventId), YEAR_S);
  return sent;
}

/** The job: every session that ended at least SETTLE_MS ago and is not sent yet. */
export async function sendDue(now = Date.now()): Promise<{ sent: number; skipped: number }> {
  const due = ((await kv.zrange(PENDING, 0, now - SETTLE_MS, { byScore: true })) ?? []) as unknown[];
  let sent = 0;
  let skipped = 0;
  for (const m of due) {
    const member = typeof m === "string" ? m : JSON.stringify(m);
    // Claimed by whoever removes it: two runs never send one session twice.
    if (Number(await kv.zrem(PENDING, member)) !== 1) continue;
    const p = (typeof m === "string" ? JSON.parse(m) : m) as { eventId: string; start: number; end: number };
    try {
      if (await sendSession(p.eventId, p.start, p.end, now)) sent++;
      else skipped++;
    } catch (err) {
      console.error("[attendance-groups] could not send", p.eventId, err);
      skipped++;
    }
  }
  return { sent, skipped };
}

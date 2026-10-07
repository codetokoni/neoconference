// src/lib/groupMeetings.ts
//
// Group meetings and calls. Each one is its own NeoEvent carrying groupId
// (and seriesId when it repeats); nothing reuses a standing room.
//
// Storage (Vercel KV, in-memory fallback as in groupStore.ts)
//   neo:event:<eid>:invited     hash   userId | lowercased email -> { source, addedBy, addedAt }
//   neo:group:<gid>:meetings    zset   eid scored by start time (epoch ms)
//   neo:series:<sid>            hash   rule, gid, createdBy, eids
//
// Who is invited
//   A scheduled or started meeting invites the group as it is when someone
//   arrives, so a member who joins the group after the meeting was set up is
//   invited too, and one who left is not. "group" rows in the invited hash
//   record who was a member at creation (for counts and notices); they never
//   admit anyone on their own. Extras, people added during the meeting, and
//   everyone chosen for a private call are admitted by their row.
//
// Admission happens at the waiting-room knock (src/app/api/waiting-room):
// an invitee's knock writes an "admitted" queue entry, which the LiveKit
// token route already lets through. Group meetings keep the waiting room on
// by default, so anyone else waits for a host.
//
// Ownership follows the group: the event's owner is the group Owner, so the
// room cap and plan limits are the Owner's, and the Free lifetime meeting cap
// is counted against the Owner — the same gates /api/events/create applies
// to its caller.
//
// No Clerk and no Next here; the Clerk-backed gates arrive as `deps`.

import { kv } from "@/lib/kv";
import { eventStore, generateId, generateQrSeed, generateSlug } from "@/lib/eventStore";
import { hashMeetingPassword } from "@/lib/eventPassword";
import { assignMeetingRole } from "@/lib/meeting-roles";
import type { Actor, MeetingRole } from "@/lib/permissions";
import {
  GroupError,
  appendActivity,
  getMember,
  listMembers,
  type Group,
  type GroupMember,
} from "@/lib/groupStore";
import type { GroupMeetingInfo, NeoEvent, WaitingRoomEntry } from "@/types/event";
import { isValidTimezone, localParts, zonedToUtc } from "@/lib/zonedTime";
import { cancelMeetingJobs, scheduleMeetingJobs } from "@/lib/scheduler";
import { addUserMeeting, meetingStartMs } from "@/lib/userMeetings";

export { isValidTimezone, zonedToUtc } from "@/lib/zonedTime";

/* -------------------------------------------------------------------------- */
/*  Shapes and limits                                                          */
/* -------------------------------------------------------------------------- */

export type MeetingKind = GroupMeetingInfo["kind"];
export type InviteSource = "group" | "extra" | "added" | "private";

export interface InvitedEntry {
  source: InviteSource;
  addedBy: string;
  /** Epoch ms. */
  addedAt: number;
  /**
   * Who they were when invited, kept so a report still names someone who
   * never came and has since left the group.
   */
  name?: string;
  email?: string;
}

/** Someone to invite: an account, an address, or both. */
export interface InviteTarget {
  userId?: string;
  email?: string;
  name?: string;
}

export type RecurrenceFreq = "daily" | "weekly" | "monthly";

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** Every N days / weeks / months, 1–12. */
  interval: number;
  /** Weekly only: 0 = Sunday … 6 = Saturday, in the meeting's timezone. */
  byWeekday?: number[];
  /** Last date (YYYY-MM-DD, in the meeting's timezone) an occurrence may fall on. */
  until?: string;
  /** How many occurrences, 1–52 (at most 12 are created; see MAX_OCCURRENCES). */
  count?: number;
}

export interface MeetingFields {
  title: string;
  description: string;
  /** ISO instant; absent for a meeting that starts now. */
  scheduledAt?: string;
  durationMin: number;
  timezone: string;
  password?: string;
  waitingRoom: boolean;
  recurrence?: RecurrenceRule;
}

export const MEETING_LIMITS = {
  titleMax: 120,
  descriptionMax: 2000,
  passwordMax: 80,
  durationMin: { min: 5, max: 480 },
  interval: { min: 1, max: 12 },
  count: { min: 1, max: 52 },
  /** Occurrences created up front for a series. */
  maxOccurrences: 12,
  /** …and none further out than this from the first. */
  horizonDays: 90,
  extrasMax: 50,
  /** Upcoming meetings within this window of their start still count as upcoming. */
  staleAfterMs: 24 * 60 * 60 * 1000,
  pageSize: 20,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  Storage                                                                    */
/* -------------------------------------------------------------------------- */

const invitedKey = (eid: string) => `neo:event:${eid}:invited`;
const meetingsKey = (gid: string) => `neo:group:${gid}:meetings`;
const seriesKey = (sid: string) => `neo:series:${sid}`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const memInvited = new Map<string, Map<string, InvitedEntry>>();
const memMeetings = new Map<string, Map<string, number>>();
const memSeries = new Map<string, SeriesRecord>();

export interface SeriesRecord {
  rule: RecurrenceRule;
  gid: string;
  createdBy: string;
  eids: string[];
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
}

function parseInvited(raw: unknown): InvitedEntry | null {
  const o = parseObject(raw);
  if (!o) return null;
  const source = o.source;
  if (source !== "group" && source !== "extra" && source !== "added" && source !== "private") return null;
  return {
    source,
    addedBy: typeof o.addedBy === "string" ? o.addedBy : "",
    addedAt: typeof o.addedAt === "number" ? o.addedAt : 0,
    ...(typeof o.name === "string" && o.name ? { name: o.name } : {}),
    ...(typeof o.email === "string" && o.email ? { email: o.email } : {}),
  };
}

/** Name and email for an invited row, when known. */
function who(name?: string, email?: string): Pick<InvitedEntry, "name" | "email"> {
  return { ...(name ? { name: name.slice(0, 120) } : {}), ...(email ? { email: email.toLowerCase() } : {}) };
}

/** userId, or a lowercased email for someone without an account. */
export function inviteKey(t: InviteTarget): string | null {
  if (t.userId && t.userId.trim()) return t.userId.trim();
  if (t.email && t.email.trim()) return t.email.trim().toLowerCase();
  return null;
}

/**
 * Record invitations. With `startMs`, each invited account also gets the
 * meeting in its own list (userMeetings.ts), for My meeting reports.
 */
export async function addInvited(eid: string, rows: Record<string, InvitedEntry>, startMs?: number): Promise<void> {
  const keys = Object.keys(rows);
  if (keys.length === 0) return;
  if (!isKvConfigured()) {
    let b = memInvited.get(eid);
    if (!b) {
      b = new Map();
      memInvited.set(eid, b);
    }
    for (const k of keys) b.set(k, rows[k]);
  } else {
    const fields: Record<string, string> = {};
    for (const k of keys) fields[k] = JSON.stringify(rows[k]);
    await kv.hset(invitedKey(eid), fields);
  }
  if (startMs !== undefined) {
    await Promise.all(keys.filter((k) => !k.includes("@")).map((k) => addUserMeeting(k, eid, startMs)));
  }
}

export async function listInvited(eid: string): Promise<Map<string, InvitedEntry>> {
  const out = new Map<string, InvitedEntry>();
  if (!isKvConfigured()) {
    for (const [k, v] of memInvited.get(eid) ?? []) out.set(k, v);
    return out;
  }
  const raw = (await kv.hgetall(invitedKey(eid))) as Record<string, unknown> | null;
  for (const [k, v] of Object.entries(raw ?? {})) {
    const e = parseInvited(v);
    if (e) out.set(k, e);
  }
  return out;
}

/** Forget an event's invitations, its queued jobs and its place in its group's list (on delete). */
export async function forgetGroupMeeting(eid: string, gid?: string): Promise<void> {
  await cancelMeetingJobs(eid);
  if (!isKvConfigured()) {
    memInvited.delete(eid);
    if (gid) memMeetings.get(gid)?.delete(eid);
    return;
  }
  await kv.del(invitedKey(eid));
  if (gid) await kv.zrem(meetingsKey(gid), eid);
}

async function indexMeeting(gid: string, eid: string, startMs: number): Promise<void> {
  if (!isKvConfigured()) {
    let b = memMeetings.get(gid);
    if (!b) {
      b = new Map();
      memMeetings.set(gid, b);
    }
    b.set(eid, startMs);
    return;
  }
  await kv.zadd(meetingsKey(gid), { score: startMs, member: eid });
}

async function unindexMeeting(gid: string, eid: string): Promise<void> {
  if (!isKvConfigured()) {
    memMeetings.get(gid)?.delete(eid);
    return;
  }
  await kv.zrem(meetingsKey(gid), eid);
}

/** Meeting ids with scores in [min, max], ascending or (rev) descending. */
async function rangeMeetings(
  gid: string,
  min: number,
  max: number,
  opts: { rev: boolean; limit: number; maxExclusive?: boolean }
): Promise<Array<{ eid: string; score: number }>> {
  if (!isKvConfigured()) {
    const rows = Array.from(memMeetings.get(gid) ?? [])
      .map(([eid, score]) => ({ eid, score }))
      .filter((r) => r.score >= min && (opts.maxExclusive ? r.score < max : r.score <= max))
      .sort((a, b) => (opts.rev ? b.score - a.score : a.score - b.score));
    return rows.slice(0, opts.limit);
  }
  type Bound = number | "-inf" | "+inf" | `(${number}`;
  const lo: Bound = Number.isFinite(min) ? min : "-inf";
  const hi: Bound = Number.isFinite(max) ? (opts.maxExclusive ? `(${max}` : max) : "+inf";
  const raw = (await (opts.rev
    ? kv.zrange(meetingsKey(gid), hi, lo, { byScore: true, rev: true, offset: 0, count: opts.limit, withScores: true })
    : kv.zrange(meetingsKey(gid), lo, hi, { byScore: true, offset: 0, count: opts.limit, withScores: true }))) as unknown[];
  const out: Array<{ eid: string; score: number }> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push({ eid: String(raw[i]), score: Number(raw[i + 1]) });
  return out;
}

async function writeSeries(sid: string, rec: SeriesRecord): Promise<void> {
  if (!isKvConfigured()) {
    memSeries.set(sid, rec);
    return;
  }
  await kv.hset(seriesKey(sid), {
    rule: JSON.stringify(rec.rule),
    gid: JSON.stringify(rec.gid),
    createdBy: JSON.stringify(rec.createdBy),
    eids: JSON.stringify(rec.eids),
  });
}

export async function getSeries(sid: string): Promise<SeriesRecord | null> {
  if (!sid) return null;
  if (!isKvConfigured()) return memSeries.get(sid) ?? null;
  const raw = (await kv.hgetall(seriesKey(sid))) as Record<string, unknown> | null;
  if (!raw) return null;
  const dec = (v: unknown) => (typeof v === "string" ? parseObject(v) ?? v : v);
  const rule = dec(raw.rule) as RecurrenceRule;
  const eids = Array.isArray(raw.eids) ? raw.eids : dec(raw.eids);
  return {
    rule,
    gid: String(raw.gid ?? ""),
    createdBy: String(raw.createdBy ?? ""),
    eids: Array.isArray(eids) ? eids.map(String) : [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Time zones and recurrence                                                  */
/* -------------------------------------------------------------------------- */

function cleanRule(raw: unknown): RecurrenceRule {
  const r = parseObject(raw);
  if (!r) throw new GroupError("invalid_recurrence");
  const freq = r.freq;
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly") throw new GroupError("invalid_recurrence");
  const interval = r.interval === undefined ? 1 : r.interval;
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < MEETING_LIMITS.interval.min ||
    interval > MEETING_LIMITS.interval.max
  ) {
    throw new GroupError("invalid_recurrence");
  }
  const rule: RecurrenceRule = { freq, interval };
  if (r.byWeekday !== undefined) {
    if (
      freq !== "weekly" ||
      !Array.isArray(r.byWeekday) ||
      r.byWeekday.length === 0 ||
      !r.byWeekday.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
    ) {
      throw new GroupError("invalid_recurrence");
    }
    rule.byWeekday = Array.from(new Set(r.byWeekday as number[])).sort((a, b) => a - b);
  }
  if (r.count !== undefined) {
    if (
      typeof r.count !== "number" ||
      !Number.isInteger(r.count) ||
      r.count < MEETING_LIMITS.count.min ||
      r.count > MEETING_LIMITS.count.max
    ) {
      throw new GroupError("invalid_recurrence");
    }
    rule.count = r.count;
  }
  if (r.until !== undefined) {
    if (typeof r.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.until) || Number.isNaN(Date.parse(r.until))) {
      throw new GroupError("invalid_recurrence");
    }
    rule.until = r.until;
  }
  if (rule.count === undefined && rule.until === undefined) throw new GroupError("invalid_recurrence");
  return rule;
}

/**
 * Every start time of a series, as ISO instants, keeping the first meeting's
 * wall-clock time in its timezone (so 10:00 stays 10:00 across a DST change).
 * At most 12, none more than 90 days after the first, and none past the
 * rule's count or until.
 */
export function materialise(startIso: string, tz: string, rule: RecurrenceRule): string[] {
  const startMs = Date.parse(startIso);
  const s = localParts(startMs, tz);
  const want = Math.min(rule.count ?? MEETING_LIMITS.maxOccurrences, MEETING_LIMITS.maxOccurrences);
  const horizon = startMs + MEETING_LIMITS.horizonDays * DAY_MS;
  let untilMs = Infinity;
  if (rule.until) {
    const [uy, um, ud] = untilParts(rule.until);
    untilMs = zonedToUtc(uy, um, ud, 23, 59, tz);
  }
  const lastMs = Math.min(horizon, untilMs);
  const out: string[] = [];
  const push = (ms: number) => {
    if (ms >= startMs && ms <= lastMs && out.length < want) out.push(new Date(ms).toISOString());
  };

  for (let k = 0; out.length < want && k < 400; k++) {
    if (rule.freq === "daily") {
      const ms = zonedToUtc(s.y, s.m, s.d + k * rule.interval, s.h, s.mi, tz);
      if (ms > lastMs) break;
      push(ms);
    } else if (rule.freq === "weekly") {
      const days = rule.byWeekday ?? [s.wd];
      const weekStart = s.d - s.wd + 7 * k * rule.interval;
      if (zonedToUtc(s.y, s.m, weekStart, s.h, s.mi, tz) > lastMs) break;
      for (const wd of days) push(zonedToUtc(s.y, s.m, weekStart + wd, s.h, s.mi, tz));
    } else {
      const ms = zonedToUtc(s.y, s.m + k * rule.interval, s.d, s.h, s.mi, tz);
      if (ms > lastMs) break;
      // The 31st in a 30-day month rolls into the next; that month is skipped.
      if (localParts(ms, tz).d === s.d) push(ms);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** Fields for a new meeting. `now` is when the request arrived. */
export function cleanMeetingFields(
  raw: Record<string, unknown>,
  mode: "scheduled" | "now" | "call",
  now: number = Date.now()
): MeetingFields {
  const title = typeof raw.title === "string" ? raw.title.trim().replace(/\s+/g, " ") : "";
  if (!title || title.length > MEETING_LIMITS.titleMax) throw new GroupError("invalid_title");

  const description = raw.description == null ? "" : raw.description;
  if (typeof description !== "string" || description.length > MEETING_LIMITS.descriptionMax) {
    throw new GroupError("invalid_description");
  }

  const timezone = raw.timezone === undefined ? "UTC" : raw.timezone;
  if (!isValidTimezone(timezone)) throw new GroupError("invalid_timezone");

  const duration = raw.durationMin === undefined ? 60 : raw.durationMin;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < MEETING_LIMITS.durationMin.min ||
    duration > MEETING_LIMITS.durationMin.max
  ) {
    throw new GroupError("invalid_duration");
  }

  let password: string | undefined;
  if (raw.password != null && raw.password !== "") {
    if (typeof raw.password !== "string" || raw.password.length > MEETING_LIMITS.passwordMax) {
      throw new GroupError("invalid_password");
    }
    password = raw.password;
  }

  let scheduledAt: string | undefined;
  let recurrence: RecurrenceRule | undefined;
  if (mode === "scheduled") {
    const at = typeof raw.scheduledAt === "string" ? Date.parse(raw.scheduledAt) : NaN;
    // A minute's grace for a form submitted right on the hour.
    if (!Number.isFinite(at) || at < now - 60_000) throw new GroupError("invalid_time");
    scheduledAt = new Date(at).toISOString();
    if (raw.recurrence != null) {
      recurrence = cleanRule(raw.recurrence);
      if (recurrence.until) {
        const [uy, um, ud] = untilParts(recurrence.until);
        if (zonedToUtc(uy, um, ud, 23, 59, timezone) < at) throw new GroupError("invalid_recurrence");
      }
    }
  }

  // A started meeting or a call is private to whoever is let in; only a
  // scheduled meeting may turn its waiting room off.
  const waitingRoom = mode === "scheduled" ? raw.waitingRoom !== false : true;

  return {
    title,
    description: description.trim(),
    ...(scheduledAt ? { scheduledAt } : {}),
    durationMin: duration,
    timezone,
    ...(password ? { password } : {}),
    waitingRoom,
    ...(recurrence ? { recurrence } : {}),
  };
}

function untilParts(until: string): [number, number, number] {
  const [y, m, d] = until.split("-").map(Number);
  return [y, m - 1, d];
}

/* -------------------------------------------------------------------------- */
/*  Who is invited                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Whether this person is invited to this group meeting right now. Asked when
 * they knock; see the module header for the rules.
 */
export async function isInvited(ev: NeoEvent, userId: string, emails: string[]): Promise<boolean> {
  if (!ev.groupId || !ev.groupMeeting || ev.groupMeeting.cancelledAt) return false;
  if (ev.groupMeeting.kind !== "call" && (await getMember(ev.groupId, userId))) return true;
  const invited = await listInvited(ev.id);
  const admits = (key: string) => {
    const row = invited.get(key);
    return Boolean(row && row.source !== "group");
  };
  return admits(userId) || emails.some((e) => admits(e.toLowerCase()));
}

/**
 * Let an invitee through the waiting room: their queue entry becomes
 * "admitted", which the token route honours for the rest of this session of
 * the meeting. Returns false, changing nothing, for anyone not invited.
 */
export async function admitInvitee(
  ev: NeoEvent,
  caller: { userId: string; emails: string[]; name: string }
): Promise<boolean> {
  if (!(await isInvited(ev, caller.userId, caller.emails))) return false;
  const now = Date.now();
  const entry: WaitingRoomEntry = {
    id: caller.userId,
    name: caller.name,
    ...(caller.emails[0] ? { email: caller.emails[0] } : {}),
    requestedAt: now,
    status: "admitted",
    decidedAt: now,
  };
  await eventStore.update(ev.id, (prev) => ({
    ...prev,
    waitingRoom: [...(prev.waitingRoom || []).filter((e) => e.id !== caller.userId), entry],
    updatedAt: new Date(now).toISOString(),
  }));
  return true;
}

/** A person to tell about a meeting. */
export interface Recipient {
  userId?: string;
  email?: string;
  name: string;
}

/**
 * Everyone invited to a meeting as people to notify, without `except`
 * (usually whoever made the change, who does not need telling).
 */
export async function inviteesOf(ev: NeoEvent, except?: string): Promise<Recipient[]> {
  if (!ev.groupId || !ev.groupMeeting) return [];
  const [members, invited] = await Promise.all([listMembers(ev.groupId), listInvited(ev.id)]);
  const byId = new Map(members.map((m) => [m.userId, m]));
  const out = new Map<string, Recipient>();
  if (ev.groupMeeting.kind !== "call") {
    for (const m of members) out.set(m.userId, { userId: m.userId, email: m.email, name: m.name });
  }
  for (const [key, row] of invited) {
    if (row.source === "group" || out.has(key)) continue;
    if (key.includes("@")) out.set(key, { email: key, name: key });
    else {
      const m = byId.get(key);
      out.set(key, { userId: key, email: m?.email, name: m?.name ?? "Member" });
    }
  }
  if (except) out.delete(except);
  return Array.from(out.values());
}

/** How many people a meeting invites, as the list shows it. */
export async function invitedCount(ev: NeoEvent, members: GroupMember[]): Promise<number> {
  const invited = await listInvited(ev.id);
  if (ev.groupMeeting?.kind === "call") return invited.size;
  const keys = new Set(members.map((m) => m.userId));
  for (const [key, row] of invited) if (row.source !== "group") keys.add(key);
  return keys.size;
}

/* -------------------------------------------------------------------------- */
/*  Creating                                                                   */
/* -------------------------------------------------------------------------- */

/** The Clerk-backed gates /api/events/create applies, handed in by the route. */
export interface CreateMeetingDeps {
  checkCap(userId: string): Promise<{ blocked: boolean; used: number; cap: number; plan: string }>;
  incrementCap(userId: string): Promise<void>;
  applyRecurringRoles(eventId: string, ownerUserId: string): Promise<void>;
}

export interface CreateMeetingArgs {
  group: Group;
  /** The member creating it. */
  creator: GroupMember;
  kind: MeetingKind;
  fields: MeetingFields;
  /** For a call: the members chosen (the creator is added automatically). */
  callUserIds?: string[];
  /** For a scheduled meeting: people outside the group to invite as well. */
  extras?: InviteTarget[];
  /** Site origin, for the event's link. */
  origin: string;
}

/** Refused by the group Owner's Free-plan lifetime cap. */
export class LifetimeCapError extends GroupError {
  constructor(
    public readonly detail: { plan: string; used: number; cap: number; needed: number }
  ) {
    super("lifetime_meetings_exhausted", 403);
  }
}

/** The member who owns the group, whose plan the meeting runs on. */
function ownerOf(members: GroupMember[]): GroupMember {
  const owner = members.find((m) => m.role === "owner");
  if (!owner) throw new GroupError("group_has_no_owner", 409);
  return owner;
}

/**
 * Meeting roles mirror group roles: Hosts host, Moderators moderate, Members
 * take part. Whoever created the meeting hosts it whatever their group rank,
 * so a Moderator who schedules a meeting can run it. The Owner owns the event
 * and needs no assignment.
 */
async function seedRoles(ev: NeoEvent, members: GroupMember[], creatorId: string): Promise<void> {
  const ownerActor: Actor = {
    userId: ev.ownerUserId,
    emails: [],
    isPlatformAdmin: false,
    role: "owner",
    isOwner: true,
    reason: "owner",
  };
  for (const m of members) {
    if (m.userId === ev.ownerUserId) continue;
    // Host is the highest meeting role below the owner, so the creator's
    // "at least host" is exactly host.
    const role: MeetingRole | null =
      m.userId === creatorId ? "host" : m.role === "host" ? "host" : m.role === "moderator" ? "moderator" : null;
    if (!role) continue;
    try {
      await assignMeetingRole(ev.id, { userId: m.userId }, role, ownerActor);
    } catch (err) {
      console.warn("[groupMeetings] role seed failed", m.userId, role, err);
    }
  }
}

/**
 * Create a meeting, a started meeting, or a call — one event, or one per
 * occurrence of a series. Every gate is checked before anything is written.
 */
export async function createGroupMeetings(
  args: CreateMeetingArgs,
  deps: CreateMeetingDeps
): Promise<{ events: NeoEvent[]; seriesId?: string }> {
  const { group, creator, kind, fields, origin } = args;
  const members = await listMembers(group.id);
  const owner = ownerOf(members);
  const memberIds = new Set(members.map((m) => m.userId));

  const starts =
    kind === "scheduled" && fields.scheduledAt
      ? fields.recurrence
        ? materialise(fields.scheduledAt, fields.timezone, fields.recurrence)
        : [fields.scheduledAt]
      : [new Date().toISOString()];
  if (starts.length === 0) throw new GroupError("invalid_recurrence");

  let callIds: string[] = [];
  if (kind === "call") {
    callIds = Array.from(new Set([...(args.callUserIds ?? []), creator.userId]));
    const strangers = callIds.filter((id) => !memberIds.has(id));
    if (strangers.length > 0) throw new GroupError("not_member", 400);
    if (callIds.length < 2) throw new GroupError("no_members");
  }
  const extras = (args.extras ?? []).slice(0, MEETING_LIMITS.extrasMax);

  // The Owner's Free-plan lifetime cap, for every occurrence about to exist.
  const cap = await deps.checkCap(owner.userId);
  if (cap.blocked || (cap.cap > 0 && cap.used + starts.length > cap.cap)) {
    throw new LifetimeCapError({ plan: cap.plan, used: cap.used, cap: cap.cap, needed: starts.length });
  }

  const seriesId = starts.length > 1 ? `s-${generateQrSeed()}` : undefined;
  const nowIso = new Date().toISOString();
  const passwordHash = fields.password ? hashMeetingPassword(fields.password.slice(0, MEETING_LIMITS.passwordMax)) : undefined;
  const events: NeoEvent[] = [];

  for (const startIso of starts) {
    const slug = await generateSlug(fields.title, async (candidate) => Boolean(await eventStore.bySlug(candidate)));
    const live = kind !== "scheduled";
    const ev: NeoEvent = {
      id: generateId(),
      slug,
      name: fields.title,
      ...(fields.description ? { description: fields.description } : {}),
      ownerUserId: owner.userId,
      ...(owner.email ? { ownerEmail: owner.email } : {}),
      ownerName: owner.name,
      visibility: "private",
      ...(passwordHash ? { password: passwordHash } : {}),
      waitingRoomEnabled: fields.waitingRoom,
      waitForHost: true,
      ...(live ? {} : { scheduledAt: startIso }),
      livekitRoom: slug,
      // A shortlink per occurrence would spend the shortener's hourly quota
      // on a single series; the short form is the site's own /<slug>.
      hsmoh: { shortCode: slug, shortUrl: `${origin}/${slug}`, fallback: true },
      qrSeed: generateQrSeed(),
      roles: [],
      waitingRoom: [],
      recordings: [],
      state: live ? "live" : "scheduled",
      ...(live ? { startedAt: startIso } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
      groupId: group.id,
      ...(seriesId ? { seriesId } : {}),
      groupMeeting: {
        kind,
        durationMin: fields.durationMin,
        timezone: fields.timezone,
        createdBy: creator.userId,
        sequence: 0,
      },
    };
    await eventStore.create(ev);
    await seedRoles(ev, members, creator.userId);
    try {
      await deps.applyRecurringRoles(ev.id, owner.userId);
    } catch (err) {
      console.warn("[groupMeetings] recurring-roles seed failed", err);
    }

    const at = Date.now();
    const rows: Record<string, InvitedEntry> = {};
    if (kind === "call") {
      for (const id of callIds) {
        const m = members.find((x) => x.userId === id);
        rows[id] = { source: "private", addedBy: creator.userId, addedAt: at, ...who(m?.name, m?.email) };
      }
    } else {
      for (const m of members) rows[m.userId] = { source: "group", addedBy: creator.userId, addedAt: at, ...who(m.name, m.email) };
      for (const t of extras) {
        const key = inviteKey(t);
        if (key && !rows[key]) rows[key] = { source: "extra", addedBy: creator.userId, addedAt: at, ...who(t.name, t.email) };
      }
    }
    await addInvited(ev.id, rows, Date.parse(startIso));
    await indexMeeting(group.id, ev.id, Date.parse(startIso));
    // Reminders an hour and half an hour ahead, and the first ring at the
    // start (src/lib/ringEngine.ts). A meeting that starts now rings at once
    // from its route instead.
    if (kind === "scheduled") await scheduleMeetingJobs(ev);
    events.push(ev);
  }

  for (let i = 0; i < events.length; i++) await deps.incrementCap(owner.userId);

  if (seriesId && fields.recurrence) {
    await writeSeries(seriesId, {
      rule: fields.recurrence,
      gid: group.id,
      createdBy: creator.userId,
      eids: events.map((e) => e.id),
    });
  }

  const first = events[0];
  await appendActivity(group.id, {
    actorId: creator.userId,
    type: kind === "call" ? "call_started" : kind === "now" ? "meeting_started" : "meeting_scheduled",
    detail:
      kind === "call"
        ? `${creator.name} started a call with ${callIds.length - 1} ${callIds.length === 2 ? "member" : "members"}`
        : kind === "now"
          ? `${creator.name} started “${first.name}”`
          : events.length > 1
            ? `${creator.name} scheduled “${first.name}” (${events.length} meetings)`
            : `${creator.name} scheduled “${first.name}”`,
  });
  // The group's chat says so (calls are private and say nothing). Loaded
  // here: groupChatEvents reads reports, which read this module.
  if (kind !== "call") {
    const chat = await import("@/lib/groupChatEvents");
    try {
      if (kind === "scheduled") await chat.announceScheduled(events, creator.name);
      else {
        await chat.trackOpenMeeting(first.id);
        await chat.announceStarted(first);
      }
    } catch (err) {
      console.warn("[groupMeetings] chat line failed", err);
    }
  }
  return { events, ...(seriesId ? { seriesId } : {}) };
}

/* -------------------------------------------------------------------------- */
/*  Adding people to a meeting                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Invite more people to the same meeting — how a call grows into a
 * conference. Nothing restarts; the newly invited are admitted on their next
 * knock. Returns only the people who were not already invited.
 */
export async function addParticipants(
  ev: NeoEvent,
  targets: InviteTarget[],
  addedBy: GroupMember
): Promise<InviteTarget[]> {
  if (!ev.groupId || !ev.groupMeeting) throw new GroupError("not_group_meeting", 404);
  if (ev.groupMeeting.cancelledAt || (ev.state !== "live" && ev.state !== "scheduled")) {
    throw new GroupError("meeting_not_open", 409);
  }
  const [invited, members] = await Promise.all([listInvited(ev.id), listMembers(ev.groupId)]);
  const memberIds = new Set(members.map((m) => m.userId));
  const wholeGroup = ev.groupMeeting.kind !== "call";
  const at = Date.now();
  const rows: Record<string, InvitedEntry> = {};
  const added: InviteTarget[] = [];
  for (const t of targets) {
    const key = inviteKey(t);
    if (!key || rows[key]) continue;
    const existing = invited.get(key);
    const alreadyIn = (existing && existing.source !== "group") || (wholeGroup && memberIds.has(key));
    if (alreadyIn) continue;
    rows[key] = { source: "added", addedBy: addedBy.userId, addedAt: at, ...who(t.name, t.email) };
    added.push(t);
  }
  await addInvited(ev.id, rows, meetingStartMs(ev));
  if (added.length > 0) {
    await appendActivity(ev.groupId, {
      actorId: addedBy.userId,
      type: "participants_added",
      detail: `${addedBy.name} added ${added.length} ${added.length === 1 ? "person" : "people"} to “${ev.name}”`,
    });
  }
  return added;
}

/* -------------------------------------------------------------------------- */
/*  Editing and cancelling                                                     */
/* -------------------------------------------------------------------------- */

export type ChangeScope = "this" | "following";

/** The scheduled meetings a change applies to, in start order. */
export async function meetingsInScope(ev: NeoEvent, scope: ChangeScope): Promise<NeoEvent[]> {
  if (scope === "this" || !ev.seriesId) return [ev];
  const series = await getSeries(ev.seriesId);
  if (!series) return [ev];
  const all = await Promise.all(series.eids.map((id) => eventStore.byId(id)));
  const from = Date.parse(ev.scheduledAt || ev.createdAt);
  return all
    .filter((e): e is NeoEvent => Boolean(e))
    .filter((e) => e.state === "scheduled" && !e.groupMeeting?.cancelledAt)
    .filter((e) => Date.parse(e.scheduledAt || e.createdAt) >= from)
    .sort((a, b) => Date.parse(a.scheduledAt || "") - Date.parse(b.scheduledAt || ""));
}

function assertEditable(ev: NeoEvent): void {
  if (!ev.groupId || !ev.groupMeeting) throw new GroupError("not_group_meeting", 404);
  if (ev.groupMeeting.cancelledAt || ev.state !== "scheduled") throw new GroupError("meeting_not_editable", 409);
}

export interface MeetingPatch {
  title?: unknown;
  description?: unknown;
  scheduledAt?: unknown;
  durationMin?: unknown;
  password?: unknown;
  waitingRoom?: unknown;
}

/**
 * Change one scheduled meeting, or it and every later one in its series. A
 * new start time moves each later meeting by the same amount.
 */
export async function updateGroupMeetings(
  ev: NeoEvent,
  patch: MeetingPatch,
  scope: ChangeScope,
  actor: GroupMember,
  now: number = Date.now()
): Promise<NeoEvent[]> {
  assertEditable(ev);
  const info = ev.groupMeeting!;
  // Validate the patch as a whole meeting, reusing the creation rules.
  const merged = cleanMeetingFields(
    {
      title: patch.title ?? ev.name,
      description: patch.description ?? ev.description ?? "",
      scheduledAt: patch.scheduledAt ?? ev.scheduledAt,
      durationMin: patch.durationMin ?? info.durationMin,
      timezone: info.timezone,
      waitingRoom: patch.waitingRoom ?? ev.waitingRoomEnabled,
      password: typeof patch.password === "string" ? patch.password : undefined,
    },
    "scheduled",
    now
  );
  const shift =
    patch.scheduledAt !== undefined ? Date.parse(merged.scheduledAt!) - Date.parse(ev.scheduledAt || "") : 0;
  const clearPassword = patch.password === null || patch.password === "";
  const newHash = typeof patch.password === "string" && patch.password ? hashMeetingPassword(merged.password!) : undefined;

  const targets = await meetingsInScope(ev, scope);
  const out: NeoEvent[] = [];
  for (const target of targets) {
    const startMs = Date.parse(target.scheduledAt || "") + shift;
    const next = await eventStore.update(target.id, (prev) => {
      const { password: oldPassword, ...rest } = prev;
      const password = clearPassword ? undefined : newHash ?? oldPassword;
      return {
        ...rest,
        ...(password ? { password } : {}),
        name: merged.title,
        description: merged.description || undefined,
        scheduledAt: new Date(startMs).toISOString(),
        waitingRoomEnabled: merged.waitingRoom,
        groupMeeting: {
          ...prev.groupMeeting!,
          durationMin: merged.durationMin,
          sequence: (prev.groupMeeting?.sequence ?? 0) + 1,
        },
        updatedAt: new Date(now).toISOString(),
      };
    });
    if (next) {
      await indexMeeting(ev.groupId!, next.id, startMs);
      await scheduleMeetingJobs(next, now);
      out.push(next);
    }
  }
  await appendActivity(ev.groupId!, {
    actorId: actor.userId,
    type: "meeting_updated",
    detail:
      out.length > 1
        ? `${actor.name} changed “${merged.title}” (${out.length} meetings)`
        : `${actor.name} changed “${merged.title}”`,
  });
  return out;
}

/** Cancel one scheduled meeting, or it and every later one in its series. */
export async function cancelGroupMeetings(
  ev: NeoEvent,
  scope: ChangeScope,
  actor: GroupMember,
  now: number = Date.now()
): Promise<NeoEvent[]> {
  assertEditable(ev);
  const targets = await meetingsInScope(ev, scope);
  const at = new Date(now).toISOString();
  const out: NeoEvent[] = [];
  for (const target of targets) {
    const next = await eventStore.update(target.id, (prev) => ({
      ...prev,
      state: "archived",
      groupMeeting: {
        ...prev.groupMeeting!,
        cancelledAt: at,
        sequence: (prev.groupMeeting?.sequence ?? 0) + 1,
      },
      updatedAt: at,
    }));
    await unindexMeeting(ev.groupId!, target.id);
    await cancelMeetingJobs(target.id);
    if (next) out.push(next);
  }
  await appendActivity(ev.groupId!, {
    actorId: actor.userId,
    type: "meeting_cancelled",
    detail:
      out.length > 1
        ? `${actor.name} cancelled “${ev.name}” (${out.length} meetings)`
        : `${actor.name} cancelled “${ev.name}”`,
  });
  if (out.length > 0) {
    // Loaded here: groupChatEvents reads reports, which read this module.
    const { announceCancelled } = await import("@/lib/groupChatEvents");
    await announceCancelled(out, actor.name).catch((err) => console.warn("[groupMeetings] chat line failed", err));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Listing                                                                    */
/* -------------------------------------------------------------------------- */

export interface MeetingListItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  state: NeoEvent["state"];
  kind: MeetingKind;
  /** ISO start: the scheduled time, or when it went live. */
  start: string;
  durationMin: number;
  timezone: string;
  seriesId?: string;
  invitedCount: number;
  /** Only for meetings that have ended. */
  attendedCount?: number;
  hasPassword: boolean;
  waitingRoom: boolean;
  createdBy: string;
}

/**
 * Whether `userId` should see this meeting in its group's lists and
 * reports: a private call only to the people in it.
 */
export async function visibleTo(ev: NeoEvent, userId: string): Promise<boolean> {
  if (ev.groupMeeting?.kind !== "call") return true;
  return (await listInvited(ev.id)).has(userId);
}

function startOf(ev: NeoEvent): string {
  return ev.scheduledAt || ev.startedAt || ev.createdAt;
}

async function toItem(
  ev: NeoEvent,
  members: GroupMember[],
  countAttended?: (ev: NeoEvent) => Promise<number>
): Promise<MeetingListItem> {
  const info = ev.groupMeeting!;
  const ended = ev.state === "ended" || ev.state === "replay";
  return {
    id: ev.id,
    slug: ev.slug,
    title: ev.name,
    description: ev.description || "",
    state: ev.state,
    kind: info.kind,
    start: startOf(ev),
    durationMin: info.durationMin,
    timezone: info.timezone,
    ...(ev.seriesId ? { seriesId: ev.seriesId } : {}),
    invitedCount: await invitedCount(ev, members),
    ...(ended && countAttended ? { attendedCount: await countAttended(ev) } : {}),
    hasPassword: Boolean(ev.password),
    waitingRoom: ev.waitingRoomEnabled,
    createdBy: info.createdBy,
  };
}

/**
 * Upcoming: live ones first, then scheduled ones soonest first.
 * Past: newest first, a page at a time; `cursor` is the start (epoch ms) the
 * next page continues below.
 */
export async function listGroupMeetings(
  gid: string,
  viewerId: string,
  scope: "upcoming" | "past",
  opts: { cursor?: number; now?: number; countAttended?: (ev: NeoEvent) => Promise<number> } = {}
): Promise<{ items: MeetingListItem[]; nextCursor: number | null }> {
  const now = opts.now ?? Date.now();
  const members = await listMembers(gid);
  if (scope === "upcoming") {
    const rows = await rangeMeetings(gid, now - MEETING_LIMITS.staleAfterMs, Infinity, { rev: false, limit: 200 });
    const events = (await Promise.all(rows.map((r) => eventStore.byId(r.eid)))).filter(
      (e): e is NeoEvent =>
        Boolean(e?.groupMeeting) && !e!.groupMeeting!.cancelledAt && ["scheduled", "waiting", "live"].includes(e!.state)
    );
    const shown: NeoEvent[] = [];
    for (const e of events) if (await visibleTo(e, viewerId)) shown.push(e);
    shown.sort((a, b) => {
      const al = a.state === "live" ? 0 : 1;
      const bl = b.state === "live" ? 0 : 1;
      return al - bl || Date.parse(startOf(a)) - Date.parse(startOf(b));
    });
    return { items: await Promise.all(shown.map((e) => toItem(e, members))), nextCursor: null };
  }

  const limit = MEETING_LIMITS.pageSize;
  const max = opts.cursor ?? now;
  const rows = await rangeMeetings(gid, -Infinity, max, { rev: true, limit, maxExclusive: opts.cursor !== undefined });
  const events = (await Promise.all(rows.map((r) => eventStore.byId(r.eid)))).filter(
    (e): e is NeoEvent => Boolean(e?.groupMeeting) && (e!.state === "ended" || e!.state === "replay")
  );
  const shown: NeoEvent[] = [];
  for (const e of events) if (await visibleTo(e, viewerId)) shown.push(e);
  return {
    items: await Promise.all(shown.map((e) => toItem(e, members, opts.countAttended))),
    nextCursor: rows.length === limit ? rows[rows.length - 1].score : null,
  };
}

/**
 * The group meetings `userId` is invited to that have not happened yet, across
 * all their groups, soonest first — for the dashboard.
 */
export async function upcomingForUser(
  groups: Array<{ id: string; name: string }>,
  userId: string,
  limit = 10,
  now: number = Date.now()
): Promise<Array<MeetingListItem & { groupId: string; groupName: string }>> {
  const lists = await Promise.all(
    groups.map(async (g) => {
      const { items } = await listGroupMeetings(g.id, userId, "upcoming", { now });
      return items.map((i) => ({ ...i, groupId: g.id, groupName: g.name }));
    })
  );
  return lists
    .flat()
    .sort((a, b) => {
      const al = a.state === "live" ? 0 : 1;
      const bl = b.state === "live" ? 0 : 1;
      return al - bl || Date.parse(a.start) - Date.parse(b.start);
    })
    .slice(0, limit);
}

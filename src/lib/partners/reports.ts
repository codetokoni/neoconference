// src/lib/partners/reports.ts — prayer reports for partner zones, from what
// src/lib/partners/attendance.ts stores. Three things are kept apart:
//
//   Session duration           how long a prayer session itself ran
//                              (first connection to last departure).
//   Participant prayer time    one person's counted connected time.
//   Total participant prayer   the sum of every participant's time:
//   time                       10 people for 30 minutes = 5 hours, while
//                              the session lasted 30 minutes.
//
// Average prayer time = total participant prayer time / unique participants,
// both for the selected period.
//
// Every person is one room identity: the integration and the partner's own
// user id, never a display name. Within a report, all of a person's
// connections in every session (and every zone) in scope are merged before
// summing, so simultaneous connections never count twice; then clipped to
// the period. Periods are worked out in the partner's timezone; every
// timestamp is stored and answered in UTC (ms) with the timezone named.

import { kv } from "@/lib/kv";
import { AK, currentSession, getPerson, getSessions, personIntervals, type PersonRecord, type PrayerSession } from "@/lib/partners/attendance";
import { clipIntervals, mergeIntervals, totalMs, type Interval } from "@/lib/partners/attendanceMath";
import { PartnerError, type PartnerIntegration, type ZoneMapping } from "@/lib/partners/store";

/* ---------------------------------- time ---------------------------------- */

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

type Wall = { y: number; m: number; d: number; h: number; min: number; s: number; weekday: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The wall clock in `tz` at instant `ts`. weekday: Monday 0 … Sunday 6. */
export function wallClock(ts: number, tz: string): Wall {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    min: Number(p.minute),
    s: Number(p.second),
    weekday: WEEKDAYS.indexOf(String(p.weekday)),
  };
}

function offsetAt(ts: number, tz: string): number {
  const w = wallClock(ts, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ts / 1000) * 1000;
}

/** The instant the wall clock in `tz` reads y-m-d 00:00 (months and days may overflow, as Date.UTC allows). */
export function midnightIn(tz: string, y: number, m: number, d: number): number {
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall - offsetAt(wall, tz);
  for (let i = 0; i < 3; i++) {
    const next = wall - offsetAt(guess, tz);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** "2026-10-21 07:05:09" on the wall clock in `tz`. */
export function wallString(ts: number, tz: string): string {
  const w = wallClock(ts, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${p(w.m)}-${p(w.d)} ${p(w.h)}:${p(w.min)}:${p(w.s)}`;
}

export type PeriodKind = "current" | "today" | "week" | "month" | "custom";
export type Period = { kind: PeriodKind; from: number; to: number; timezone: string; label: string };

function ymd(raw: unknown): { y: number; m: number; d: number } | null {
  const m = typeof raw === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim()) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const back = new Date(Date.UTC(y, mo - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? { y, m: mo, d } : null;
}

/**
 * A report period in the partner's timezone. Weeks start on Monday.
 * Custom ranges are whole days, both ends included: from=2026-10-01&to=2026-10-31.
 * "current" is the zone's open session (set by the caller); here it spans up to now.
 */
export function resolvePeriod(q: { period?: string | null; from?: string | null; to?: string | null }, timezone: string, now = Date.now()): Period {
  const kind = (q.period || "today") as PeriodKind;
  const w = wallClock(now, timezone);
  if (kind === "today") {
    return { kind, from: midnightIn(timezone, w.y, w.m, w.d), to: midnightIn(timezone, w.y, w.m, w.d + 1), timezone, label: `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}` };
  }
  if (kind === "week") {
    const from = midnightIn(timezone, w.y, w.m, w.d - w.weekday);
    return { kind, from, to: midnightIn(timezone, w.y, w.m, w.d - w.weekday + 7), timezone, label: `week of ${wallString(from, timezone).slice(0, 10)}` };
  }
  if (kind === "month") {
    return { kind, from: midnightIn(timezone, w.y, w.m, 1), to: midnightIn(timezone, w.y, w.m + 1, 1), timezone, label: `${w.y}-${String(w.m).padStart(2, "0")}` };
  }
  if (kind === "custom") {
    const a = ymd(q.from);
    const b = ymd(q.to);
    if (!a || !b) throw new PartnerError(400, "invalid_range", "Custom periods need from and to as YYYY-MM-DD.");
    const from = midnightIn(timezone, a.y, a.m, a.d);
    const to = midnightIn(timezone, b.y, b.m, b.d + 1);
    if (to <= from) throw new PartnerError(400, "invalid_range", "to must be on or after from.");
    if (to - from > MAX_RANGE_DAYS * DAY_MS + DAY_MS) throw new PartnerError(400, "range_too_long", `At most ${MAX_RANGE_DAYS} days.`);
    return { kind, from, to, timezone, label: `${q.from} to ${q.to}` };
  }
  if (kind === "current") return { kind, from: now, to: now, timezone, label: "current session" };
  throw new PartnerError(400, "invalid_period", "period: current, today, week, month or custom.");
}

/* -------------------------------- gathering -------------------------------- */

type Seen = { session: PrayerSession; person: PersonRecord };

/** The zone's sessions that overlap [from, to); for "current", its open session only. */
async function sessionsFor(integrationId: string, zone: string, period: Period, now: number): Promise<PrayerSession[]> {
  const open = await currentSession(integrationId, zone, now);
  if (period.kind === "current") return open ? [open] : [];
  const ended = (await kv.zrange(AK.byEnd(integrationId, zone), period.from, "+inf", { byScore: true })) as string[];
  const sessions = (await getSessions(ended.map(String))).filter((s) => s.startedAt < period.to);
  if (open && open.startedAt < period.to && !sessions.some((s) => s.id === open.id)) sessions.push(open);
  return sessions.sort((a, b) => a.startedAt - b.startedAt);
}

async function peopleIn(s: PrayerSession, only?: string): Promise<Seen[]> {
  const ids = only ? [only] : (((await kv.smembers(AK.people(s.id))) as string[]) || []).map(String);
  const people = await Promise.all(ids.map((id) => getPerson(s.id, id)));
  return people.filter((p): p is PersonRecord => !!p && Object.keys(p.connections).length > 0).map((person) => ({ session: s, person }));
}

/* --------------------------------- reports --------------------------------- */

export type ParticipantRow = {
  /** The partner's user id (or the guest visit's id). */
  userId: string;
  guest: boolean;
  name: string;
  firstJoined: number | null;
  /** Null while connected. */
  lastLeft: number | null;
  sessionsAttended: number;
  prayerSeconds: number;
  connected: boolean;
  zones: string[];
};

export type SessionRow = {
  id: string;
  zoneId: string;
  meetingId: string;
  startedAt: number;
  endedAt: number | null;
  /** How long the session ran (to now while open), not anyone's prayer time. */
  durationSeconds: number;
  participants: number;
  /** All participants' counted time in this session, within the period. */
  prayerSeconds: number;
};

export type ReportSummary = {
  sessions: number;
  uniqueParticipants: number;
  connectedNow: number;
  totalPrayerSeconds: number;
  averagePrayerSeconds: number;
};

export type Report = {
  integrationId: string;
  zones: { zoneId: string; name: string; meetingId: string }[];
  period: { kind: PeriodKind; from: string; to: string; timezone: string; label: string };
  summary: ReportSummary;
  sessions: SessionRow[];
  participants: ParticipantRow[];
  generatedAt: string;
};

function splitExt(ext: string): { userId: string; guest: boolean } {
  if (ext.startsWith("user:")) return { userId: ext.slice(5), guest: false };
  if (ext.startsWith("guest:")) return { userId: ext.slice(6), guest: true };
  return { userId: ext, guest: false };
}

const secs = (ms: number) => Math.floor(ms / 1000);

/**
 * A report over zones for a period. `onlyIdentity` narrows it to one
 * person (their own summary); `onlySession` to one session.
 */
export async function buildReport(opts: {
  integration: PartnerIntegration;
  zones: ZoneMapping[];
  period: Period;
  now?: number;
  onlyIdentity?: string;
  onlySession?: string;
}): Promise<Report & { intervals: Map<string, Interval[]> }> {
  const now = opts.now ?? Date.now();
  const { integration, zones, period } = opts;
  const integ = integration.id;

  let sessions: PrayerSession[] = (await Promise.all(zones.map((z) => sessionsFor(integ, z.zoneId, period, now)))).flat();
  if (opts.onlySession) sessions = sessions.filter((s) => s.id === opts.onlySession);
  // The window counted: the period, never past now; "current" is its session.
  const from = period.kind === "current" ? Math.min(...sessions.map((s) => s.startedAt), now) : period.from;
  const to = Math.min(period.kind === "current" ? now : period.to, now);

  const seen = (await Promise.all(sessions.map((s) => peopleIn(s, opts.onlyIdentity)))).flat();

  // Per person: every connection in scope, merged once, then clipped.
  const byPerson = new Map<string, { person: PersonRecord; raw: Interval[]; perSession: Map<string, Interval[]>; connected: boolean; zones: Set<string>; latest: number }>();
  for (const { session, person } of seen) {
    const { intervals, connected } = personIntervals(person, session, now);
    let e = byPerson.get(person.identity);
    if (!e) {
      e = { person, raw: [], perSession: new Map(), connected: false, zones: new Set(), latest: -Infinity };
      byPerson.set(person.identity, e);
    }
    e.raw.push(...intervals);
    e.perSession.set(session.id, intervals);
    e.connected ||= connected;
    e.zones.add(session.zoneId);
    // The most recent session's name is the one shown.
    if (session.startedAt > e.latest) {
      e.latest = session.startedAt;
      e.person = person;
    }
  }

  const participants: ParticipantRow[] = [];
  const intervals = new Map<string, Interval[]>();
  const perSessionPrayer = new Map<string, { people: number; ms: number }>();
  for (const [identity, e] of byPerson) {
    const counted = clipIntervals(mergeIntervals(e.raw), from, to);
    const ms = totalMs(counted);
    let attended = 0;
    for (const [sid, list] of e.perSession) {
      const inSession = totalMs(clipIntervals(mergeIntervals(list), from, to));
      if (inSession > 0) {
        attended++;
        const agg = perSessionPrayer.get(sid) ?? { people: 0, ms: 0 };
        agg.people++;
        agg.ms += inSession;
        perSessionPrayer.set(sid, agg);
      }
    }
    const connected = e.connected && to >= now;
    // Someone who has just connected is here, with no time counted yet.
    if (ms <= 0 && !connected) continue;
    const { userId, guest } = splitExt(e.person.ext);
    intervals.set(identity, counted);
    participants.push({
      userId,
      guest,
      name: e.person.name,
      firstJoined: counted[0]?.start ?? now,
      lastLeft: connected ? null : (counted[counted.length - 1]?.end ?? null),
      sessionsAttended: attended,
      prayerSeconds: secs(ms),
      connected,
      zones: [...e.zones].sort(),
    });
  }
  participants.sort((a, b) => b.prayerSeconds - a.prayerSeconds || a.name.localeCompare(b.name));

  const sessionRows: SessionRow[] = sessions.map((s) => {
    const agg = perSessionPrayer.get(s.id) ?? { people: 0, ms: 0 };
    return {
      id: s.id,
      zoneId: s.zoneId,
      meetingId: s.eventId,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      durationSeconds: secs((s.endedAt ?? now) - s.startedAt),
      participants: agg.people,
      prayerSeconds: secs(agg.ms),
    };
  });

  const total = participants.reduce((sum, p) => sum + p.prayerSeconds, 0);
  return {
    integrationId: integ,
    zones: zones.map((z) => ({ zoneId: z.zoneId, name: z.title, meetingId: z.eventId })),
    period: { kind: period.kind, from: new Date(from).toISOString(), to: new Date(period.kind === "current" ? now : period.to).toISOString(), timezone: period.timezone, label: period.label },
    summary: {
      sessions: sessionRows.length,
      uniqueParticipants: participants.length,
      connectedNow: participants.filter((p) => p.connected).length,
      totalPrayerSeconds: total,
      averagePrayerSeconds: participants.length ? Math.round(total / participants.length) : 0,
    },
    sessions: sessionRows,
    participants,
    generatedAt: new Date(now).toISOString(),
    intervals,
  };
}

/** A tag for "nothing has changed": the zones' change counters, and the quarter-minute while anyone's time is running. */
export async function reportTag(integrationId: string, zones: string[], now = Date.now()): Promise<string> {
  const versions = await Promise.all(zones.map(async (z) => `${z}:${Number((await kv.get(AK.version(integrationId, z))) ?? 0)}`));
  const live = (await Promise.all(zones.map((z) => currentSession(integrationId, z, now)))).some((s) => !!s);
  return `W/"${versions.join(",")}${live ? `@${Math.floor(now / 15_000)}` : ""}"`;
}

/* ----------------------------------- CSV ----------------------------------- */

function cell(v: string | number | boolean | null): string {
  let s = v == null ? "" : String(v);
  // A spreadsheet must not run a name as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function hms(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function reportCsv(r: Report): string {
  const tz = r.period.timezone;
  const rows: (string | number | boolean | null)[][] = [
    [
      "Participant",
      "User ID",
      "Guest",
      `First joined (${tz})`,
      `Last left (${tz})`,
      "First joined (UTC)",
      "Last left (UTC)",
      "Sessions attended",
      "Prayer time",
      "Prayer seconds",
      "Status",
      "Zones",
    ],
  ];
  for (const p of r.participants) {
    rows.push([
      p.name,
      p.userId,
      p.guest,
      p.firstJoined != null ? wallString(p.firstJoined, tz) : null,
      p.lastLeft != null ? wallString(p.lastLeft, tz) : null,
      p.firstJoined != null ? new Date(p.firstJoined).toISOString() : null,
      p.lastLeft != null ? new Date(p.lastLeft).toISOString() : null,
      p.sessionsAttended,
      hms(p.prayerSeconds),
      p.prayerSeconds,
      p.connected ? "connected" : "left",
      p.zones.join(" "),
    ]);
  }
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

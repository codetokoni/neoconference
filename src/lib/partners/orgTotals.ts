// src/lib/partners/orgTotals.ts — the organisation report (GET
// /api/partner/v1/reports/org) from day totals.
//
// PrayerClouds has thousands of zones and tens of thousands of attendances
// a month. Building the organisation report the way a zone's report is
// built (every zone, every session, every person, then every zone again on
// its own) took longer than any request is given (owner, 2026-11-03). So:
//
//   neo:pz:<integ>:day:<timezone>:<YYYY-MM-DD>  -> DayTotals (JSON, 400 days)
//
// One record per day in the partner's timezone, written once the day is
// over: each zone's sessions, each person's counted time in that zone, and
// each person's time across all zones (a person in two zones at once counts
// once). Days are summed into any period; the day not yet over is worked
// out live. Time is kept in milliseconds and rounded only at the end, so
// the figures are exactly those buildReport gives (src/lib/partners/reports.ts):
// a person's connections merged, then clipped, per day; the days partition
// the period, so their sum is the period's.
//
// A day is stored only GRACE_MS after it ended, when its sessions have
// closed and late departures have arrived. The nightly job
// (/api/cron/partner-totals) stores yesterday and fills any gap; a report
// that finds a day missing works it out and stores it then.
//
// Reads go in pipelines of BATCH commands: thousands of single requests at
// once ran the connection pool dry (the admin panel's 500s, 2026-11-03).

import { kv } from "@/lib/kv";
import { AK, closeSession, isStale, parsePerson, parseSession, personIntervals, type PersonRecord, type PrayerSession } from "@/lib/partners/attendance";
import { clipIntervals, mergeIntervals, totalMs, type Interval } from "@/lib/partners/attendanceMath";
import { midnightIn, wallClock, type Period, type ReportSummary } from "@/lib/partners/reports";
import type { PartnerIntegration, ZoneMapping } from "@/lib/partners/store";

const BATCH = 500;
/** How long after a day ends its totals are final enough to keep. */
export const GRACE_MS = 6 * 60 * 60 * 1000;
const KEEP_S = 400 * 24 * 60 * 60;

const dayKey = (integ: string, tz: string, day: string) => `neo:pz:${integ}:day:${tz}:${day}`;

/** One scope's totals: sessions, ms per person, and who is connected right now (live days only). */
export type ScopeTotals = { s: string[]; p: Record<string, number>; c?: string[] };
export type DayTotals = { zones: Record<string, ScopeTotals>; org: ScopeTotals };

type Pipe = ReturnType<typeof kv.pipeline>;

/** Runs `add` for every item in pipelines of BATCH; the results, in order. */
async function batched<T, R = unknown>(items: T[], add: (p: Pipe, item: T) => void): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const p = kv.pipeline();
    for (const item of items.slice(i, i + BATCH)) add(p, item);
    out.push(...((await p.exec()) as R[]));
  }
  return out;
}

type Seen = { session: PrayerSession; person: PersonRecord };

/**
 * The zones' sessions overlapping [from, to) — or, with onlyOpen, their
 * open sessions — and everyone in them. The same sessions sessionsFor()
 * finds zone by zone, read in batches. A session left open past its expiry
 * is closed, as currentSession() does.
 */
async function gather(
  integ: string,
  zoneIds: string[],
  window: { from: number; to: number } | "open",
  now: number,
): Promise<{ sessions: PrayerSession[]; seen: Seen[] }> {
  const byId = new Map<string, PrayerSession>();
  const pointers = (await batched<string, unknown>(zoneIds, (p, z) => p.get(AK.current(integ, z)))).filter((x) => x != null).map(String);
  const open = await batched<string, Record<string, unknown> | null>(pointers, (p, id) => p.hgetall(AK.session(id)));
  for (const raw of open) {
    let s = parseSession(raw);
    if (!s) continue;
    if (s.endedAt == null && isStale(s, now)) s = await closeSession(s);
    if (window === "open" ? s.endedAt == null : s.startedAt < window.to && (s.endedAt == null || s.endedAt >= window.from)) byId.set(s.id, s);
  }
  if (window !== "open") {
    const ended = (await batched<string, unknown[]>(zoneIds, (p, z) => p.zrange(AK.byEnd(integ, z), window.from, "+inf", { byScore: true })))
      .flat()
      .map(String)
      .filter((id) => !byId.has(id));
    const records = await batched<string, Record<string, unknown> | null>(ended, (p, id) => p.hgetall(AK.session(id)));
    for (const raw of records) {
      const s = parseSession(raw);
      if (s && s.startedAt < window.to) byId.set(s.id, s);
    }
  }
  const sessions = [...byId.values()];
  const people = await batched<PrayerSession, unknown[]>(sessions, (p, s) => p.smembers(AK.people(s.id)));
  const pairs = sessions.flatMap((s, i) => ((people[i] as unknown[]) ?? []).map((who) => ({ session: s, identity: String(who) })));
  const persons = await batched<{ session: PrayerSession; identity: string }, Record<string, unknown> | null>(pairs, (p, x) =>
    p.hgetall(AK.person(x.session.id, x.identity)),
  );
  const seen: Seen[] = [];
  persons.forEach((raw, i) => {
    const person = parsePerson(pairs[i].identity, raw);
    if (person && Object.keys(person.connections).length > 0) seen.push({ session: pairs[i].session, person });
  });
  return { sessions, seen };
}

/**
 * Totals for [from, to): sessions overlapping it, and each person's merged
 * time clipped to it (never past now). Connected people are kept only when
 * the window reaches now, as buildReport counts them.
 */
export function totalsOf(sessions: PrayerSession[], seen: Seen[], from: number, to: number, now: number): DayTotals {
  const end = Math.min(to, now);
  const live = to >= now;
  const inWindow = (s: PrayerSession) => s.startedAt < to && (s.endedAt == null || s.endedAt >= from);
  const zones: Record<string, ScopeTotals> = {};
  const zoneRaw = new Map<string, Map<string, { raw: Interval[]; connected: boolean }>>();
  const orgRaw = new Map<string, { raw: Interval[]; connected: boolean }>();
  const orgSessions: string[] = [];
  for (const s of sessions) {
    if (!inWindow(s)) continue;
    (zones[s.zoneId] ??= { s: [], p: {} }).s.push(s.id);
    orgSessions.push(s.id);
  }
  for (const { session, person } of seen) {
    if (!inWindow(session)) continue;
    const { intervals, connected } = personIntervals(person, session, now);
    if (!zoneRaw.has(session.zoneId)) zoneRaw.set(session.zoneId, new Map());
    for (const acc of [zoneRaw.get(session.zoneId)!, orgRaw]) {
      const e = acc.get(person.identity) ?? { raw: [], connected: false };
      e.raw.push(...intervals);
      e.connected ||= connected;
      acc.set(person.identity, e);
    }
  }
  const settle = (acc: Map<string, { raw: Interval[]; connected: boolean }>, into: ScopeTotals) => {
    const c: string[] = [];
    for (const [identity, e] of acc) {
      const ms = totalMs(clipIntervals(mergeIntervals(e.raw), from, end));
      if (ms > 0) into.p[identity] = ms;
      if (live && e.connected) c.push(identity);
    }
    if (c.length) into.c = c;
  };
  for (const [zone, acc] of zoneRaw) settle(acc, (zones[zone] ??= { s: [], p: {} }));
  const org: ScopeTotals = { s: orgSessions, p: {} };
  settle(orgRaw, org);
  return { zones, org };
}

function addInto(into: ScopeTotals & { sset?: Set<string>; cset?: Set<string> }, from: ScopeTotals) {
  for (const id of from.s) into.sset!.add(id);
  for (const [who, ms] of Object.entries(from.p)) into.p[who] = (into.p[who] ?? 0) + ms;
  for (const who of from.c ?? []) into.cset!.add(who);
}

/** Days summed: sessions counted once however many days they touch. */
export function combine(days: DayTotals[]): DayTotals {
  const zones: Record<string, ScopeTotals & { sset: Set<string>; cset: Set<string> }> = {};
  const org = { s: [], p: {}, sset: new Set<string>(), cset: new Set<string>() } as ScopeTotals & { sset: Set<string>; cset: Set<string> };
  for (const d of days) {
    for (const [zone, t] of Object.entries(d.zones)) addInto((zones[zone] ??= { s: [], p: {}, sset: new Set(), cset: new Set() }), t);
    addInto(org, d.org);
  }
  const done = (t: ScopeTotals & { sset: Set<string>; cset: Set<string> }): ScopeTotals => ({ s: [...t.sset], p: t.p, ...(t.cset.size ? { c: [...t.cset] } : {}) });
  return { zones: Object.fromEntries(Object.entries(zones).map(([z, t]) => [z, done(t)])), org: done(org) };
}

/** The summary buildReport gives for these totals. */
export function summaryOf(t: ScopeTotals | undefined): ReportSummary {
  if (!t) return { sessions: 0, uniqueParticipants: 0, connectedNow: 0, totalPrayerSeconds: 0, averagePrayerSeconds: 0 };
  const people = new Set([...Object.keys(t.p).filter((who) => t.p[who] > 0), ...(t.c ?? [])]);
  let total = 0;
  for (const who of people) total += Math.floor((t.p[who] ?? 0) / 1000);
  return {
    sessions: t.s.length,
    uniqueParticipants: people.size,
    connectedNow: (t.c ?? []).length,
    totalPrayerSeconds: total,
    averagePrayerSeconds: people.size ? Math.round(total / people.size) : 0,
  };
}

/** The days of [from, to) on the wall clock in `tz`. */
export function daysOf(from: number, to: number, tz: string): { day: string; from: number; to: number }[] {
  const out: { day: string; from: number; to: number }[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  let cur = from;
  for (let guard = 0; cur < to && guard < 400; guard++) {
    const w = wallClock(cur, tz);
    const next = midnightIn(tz, w.y, w.m, w.d + 1);
    out.push({ day: `${w.y}-${pad(w.m)}-${pad(w.d)}`, from: cur, to: Math.min(next, to) });
    cur = next;
  }
  return out;
}

/**
 * The totals for these days: stored ones as they are, the rest worked out
 * (one read of the window they span) and stored when the day is over.
 */
async function totalsForDays(
  integ: string,
  zoneIds: string[],
  tz: string,
  days: { day: string; from: number; to: number }[],
  now: number,
): Promise<{ totals: DayTotals[]; stored: number; computed: number }> {
  const closed = (d: { to: number }) => d.to + GRACE_MS <= now;
  const keep = days.filter(closed);
  const kept = await batched<{ day: string }, DayTotals | null>(keep, (p, d) => p.get(dayKey(integ, tz, d.day)));
  const have = new Map(keep.map((d, i) => [d.day, kept[i]]));
  const need = days.filter((d) => !have.get(d.day));
  const totals: DayTotals[] = days.map((d) => have.get(d.day)).filter((t): t is DayTotals => !!t);
  let computed = 0;
  if (need.length) {
    const from = Math.min(...need.map((d) => d.from));
    const to = Math.max(...need.map((d) => d.to));
    const g = await gather(integ, zoneIds, { from, to }, now);
    const fresh: { d: { day: string }; t: DayTotals }[] = [];
    for (const d of need) {
      const t = totalsOf(g.sessions, g.seen, d.from, d.to, now);
      totals.push(t);
      if (closed(d)) fresh.push({ d, t });
    }
    if (fresh.length) {
      await batched(fresh, (p, x) => p.set(dayKey(integ, tz, x.d.day), x.t, { ex: KEEP_S }));
      computed = fresh.length;
    }
  }
  return { totals, stored: totals.length - need.length, computed };
}

export type OrgReport = {
  period: { kind: Period["kind"]; from: string; to: string; timezone: string; label: string };
  summary: ReportSummary;
  zones: { zone: { zoneId: string; name: string; meetingId: string }; summary: ReportSummary }[];
  generatedAt: string;
};

/** The organisation report: the whole organisation, and each zone's own summary. */
export async function orgReport(integration: PartnerIntegration, zones: ZoneMapping[], period: Period, now = Date.now()): Promise<OrgReport> {
  const integ = integration.id;
  const zoneIds = zones.map((z) => z.zoneId);
  let total: DayTotals;
  let from = period.from;
  if (period.kind === "current") {
    const g = await gather(integ, zoneIds, "open", now);
    from = Math.min(...g.sessions.map((s) => s.startedAt), now);
    total = totalsOf(g.sessions, g.seen, from, now, now);
  } else {
    // Days still to come have nothing in them yet.
    const days = daysOf(period.from, period.to, period.timezone).filter((d) => d.from < now);
    total = combine((await totalsForDays(integ, zoneIds, period.timezone, days, now)).totals);
  }
  return {
    period: {
      kind: period.kind,
      from: new Date(from).toISOString(),
      to: new Date(period.kind === "current" ? now : period.to).toISOString(),
      timezone: period.timezone,
      label: period.label,
    },
    summary: summaryOf(total.org),
    zones: zones.map((z) => ({ zone: { zoneId: z.zoneId, name: z.title, meetingId: z.eventId }, summary: summaryOf(total.zones[z.zoneId]) })),
    generatedAt: new Date(now).toISOString(),
  };
}

/** "Has anything changed": the organisation's change counter, and the quarter-minute while the period is running. */
export async function orgReportTag(integrationId: string, period: Period, now = Date.now()): Promise<string> {
  const version = Number((await kv.get(AK.orgVersion(integrationId))) ?? 0);
  const running = period.kind === "current" || period.to > now;
  return `W/"org-${version}-${period.kind}-${period.from}-${period.to}${running ? `@${Math.floor(now / 15_000)}` : ""}"`;
}

/**
 * Stores every finished day of the last `back` days not stored yet (the
 * nightly job). Returns how many were worked out.
 */
export async function storeFinishedDays(integration: PartnerIntegration, zones: ZoneMapping[], timezone: string, now = Date.now(), back = 35): Promise<number> {
  const w = wallClock(now, timezone);
  const today = midnightIn(timezone, w.y, w.m, w.d);
  const days = daysOf(midnightIn(timezone, w.y, w.m, w.d - back), today, timezone).filter((d) => d.to + GRACE_MS <= now);
  if (!days.length) return 0;
  return (await totalsForDays(integration.id, zones.map((z) => z.zoneId), timezone, days, now)).computed;
}


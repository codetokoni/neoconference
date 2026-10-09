// src/lib/activityReports.ts
//
// The arithmetic behind /admin/analytics, kept pure so it can be checked on
// fixed data: calendar days in a time zone, hourly counters folded into
// those days, active users, weekly retention cohorts, and period-over-period
// change. Reading the stores is src/lib/admin/analytics.ts.
//
// Time zones: counters are kept per UTC hour, so a chart can be drawn in any
// zone with whole-hour offsets exactly (DST included). In a half-hour zone an
// hour is placed by its midpoint. Active-user sets and cohorts are per UTC
// day and UTC week (Monday start) — a set cannot be re-cut by hour — and the
// page says so.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
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
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    partsFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

function zonedParts(ts: number, tz: string) {
  const p: Record<string, number> = {};
  for (const x of partsFormatter(tz).formatToParts(new Date(ts))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** How far `tz`'s clock is ahead of UTC at `ts`, in ms. */
export function tzOffsetMs(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** The calendar day (YYYY-MM-DD) `ts` falls on in `tz`. */
export function dayInZone(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
}

/** Midnight at the start of `day` in `tz`, as epoch ms. */
export function zonedDayStart(day: string, tz: string): number {
  const guess = Date.parse(day + "T00:00:00Z");
  let t = guess - tzOffsetMs(guess, tz);
  // Once more: the offset at the true instant can differ across a DST change.
  t = guess - tzOffsetMs(t, tz);
  return t;
}

/** Calendar days from `from` to `to` inclusive. */
export function daysFromTo(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 1000; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isDay(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + "T00:00:00Z"));
}

export interface Period {
  from: string;
  to: string;
  tz: string;
  startMs: number;
  /** Last ms of `to` in `tz`. */
  endMs: number;
  days: string[];
}

export function period(from: string, to: string, tz: string): Period {
  const startMs = zonedDayStart(from, tz);
  const endMs = zonedDayStart(addDays(to, 1), tz) - 1;
  return { from, to, tz, startMs, endMs, days: daysFromTo(from, to) };
}

/** Longest period a report covers. */
export const MAX_PERIOD_DAYS = 366;

/**
 * `from` / `to` (YYYY-MM-DD, calendar days in `tz`) from a query string.
 * Missing or bad values give the last `defaultDays` days ending today; a
 * reversed range is swapped; longer than MAX_PERIOD_DAYS keeps the end.
 */
export function periodFromQuery(q: URLSearchParams, defaultDays: number, now = Date.now()): Period {
  const tz = isTimeZone(q.get("tz")) ? (q.get("tz") as string) : "UTC";
  const today = dayInZone(now, tz);
  let to = isDay(q.get("to")) ? (q.get("to") as string) : today;
  let from = isDay(q.get("from")) ? (q.get("from") as string) : addDays(to, -(defaultDays - 1));
  if (from > to) [from, to] = [to, from];
  if (daysFromTo(from, to).length > MAX_PERIOD_DAYS) from = addDays(to, -(MAX_PERIOD_DAYS - 1));
  return period(from, to, tz);
}

/** The same number of days immediately before `p`. */
export function previousPeriod(p: Period): Period {
  const n = p.days.length;
  return period(addDays(p.from, -n), addDays(p.from, -1), p.tz);
}

export interface Folded {
  /** "<type>" or "<type>#<value>" -> local day -> count */
  counts: Record<string, Record<string, number>>;
  /** "<type>" -> local day -> summed amount */
  sums: Record<string, Record<string, number>>;
}

/**
 * Fold per-UTC-hour counters (neo:act:hr:<utcDay> hashes) into calendar days
 * of `p.tz`, keeping only hours inside the period.
 */
export function foldHourly(hourly: Record<string, Record<string, number>>, p: Period): Folded {
  const counts: Folded["counts"] = {};
  const sums: Folded["sums"] = {};
  for (const [utcD, fields] of Object.entries(hourly)) {
    for (const [field, n] of Object.entries(fields)) {
      const parts = field.split("|");
      if (parts.length < 2) continue;
      const hh = Number(parts[1]);
      if (!Number.isInteger(hh) || hh < 0 || hh > 23) continue;
      const hourStart = Date.parse(`${utcD}T00:00:00Z`) + hh * HOUR_MS;
      const mid = hourStart + HOUR_MS / 2;
      if (mid < p.startMs || mid > p.endMs) continue;
      const local = dayInZone(mid, p.tz);
      const target = parts[2] === "sum" ? sums : counts;
      const key = parts[0];
      (target[key] ??= {})[local] = (target[key][local] ?? 0) + n;
    }
  }
  return { counts, sums };
}

export function series(byDay: Record<string, number> | undefined, days: string[]): number[] {
  return days.map((d) => byDay?.[d] ?? 0);
}

export function total(byDay: Record<string, number> | undefined): number {
  let s = 0;
  for (const v of Object.values(byDay ?? {})) s += v;
  return s;
}

/** Every "<type>#<value>" count of `type`, as value -> total. */
export function splitTotals(f: Folded, type: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, byDay] of Object.entries(f.counts)) {
    if (k.startsWith(type + "#")) out[k.slice(type.length + 1)] = total(byDay);
  }
  return out;
}

function unionOf(sets: Record<string, string[]>, days: string[]): Set<string> {
  const u = new Set<string>();
  for (const d of days) for (const id of sets[d] ?? []) u.add(id);
  return u;
}

/**
 * Daily, weekly and monthly active users from per-UTC-day sets. `days` are
 * the UTC days of the period; WAU and MAU are the distinct people in the 7
 * and 30 UTC days ending on its last day. `dau` must hold those days too.
 */
export function activeUsers(dau: Record<string, string[]>, days: string[]) {
  const last = days[days.length - 1];
  const daily = days.map((d) => (dau[d] ?? []).length);
  const window = (n: number) => unionOf(dau, daysFromTo(addDays(last, -(n - 1)), last)).size;
  return {
    daily,
    avgDaily: daily.length ? Math.round((daily.reduce((a, b) => a + b, 0) / daily.length) * 10) / 10 : 0,
    wau: window(7),
    mau: window(30),
    distinct: unionOf(dau, days).size,
  };
}

/** Monday of the UTC week `day` is in. */
export function mondayOf(day: string): string {
  const dow = new Date(day + "T00:00:00Z").getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

export interface Cohort {
  /** Monday the cohort's week started. */
  week: string;
  size: number;
  /** retained[k]: cohort members active in week k after signing up (k = 0 is the sign-up week). */
  retained: number[];
}

/**
 * Weekly retention: people who signed up in a UTC week, and how many of them
 * were active in each week after. Weeks that have not started by `today` are
 * left off the row rather than shown as 0.
 */
export function weeklyCohorts(
  newUsers: Record<string, string[]>,
  dau: Record<string, string[]>,
  fromDay: string,
  toDay: string,
  today: string,
  maxWeeks = 8,
): Cohort[] {
  const out: Cohort[] = [];
  for (let w = mondayOf(fromDay); w <= toDay; w = addDays(w, 7)) {
    const members = unionOf(newUsers, daysFromTo(w, addDays(w, 6)));
    if (!members.size) continue;
    const retained: number[] = [];
    for (let k = 0; k < maxWeeks; k++) {
      const start = addDays(w, 7 * k);
      if (start > today) break;
      const active = unionOf(dau, daysFromTo(start, addDays(start, 6)));
      let n = 0;
      for (const id of members) if (active.has(id)) n++;
      retained.push(n);
    }
    out.push({ week: w, size: members.size, retained });
  }
  return out;
}

/** Change from `prev` to `cur` as a percentage; null when there is nothing to compare with. */
export function change(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

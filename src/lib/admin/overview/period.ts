// src/lib/admin/overview/period.ts
//
// The Overview's date filter, kept pure so the page and the route agree and
// the arithmetic can be checked on fixed dates: a preset or two calendar days
// in the admin time zone, and the period it is compared with (the same number
// of days just before, or the same dates a year earlier). Calendar maths is
// the analytics page's (src/lib/activityReports.ts).

import { addDays, change, dayInZone, isDay, isTimeZone, period, type Period } from "@/lib/activityReports";

export const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "custom", label: "Custom" },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

export const COMPARES = [
  { id: "previous", label: "Previous period" },
  { id: "last_year", label: "Same period last year" },
] as const;
export type CompareId = (typeof COMPARES)[number]["id"];

/** Longest custom range: a year and a day (a leap year's worth). */
export const MAX_DAYS = 366;

export interface OverviewQuery {
  range: RangeId;
  compare: CompareId;
  tz: string;
  /** Only for range "custom": calendar days in `tz`. */
  from?: string;
  to?: string;
}

export interface Periods {
  range: RangeId;
  compare: CompareId;
  current: Period;
  previous: Period;
}

const isRange = (v: unknown): v is RangeId => RANGES.some((r) => r.id === v);
const isCompare = (v: unknown): v is CompareId => COMPARES.some((c) => c.id === v);

/** The query as the URL carries it; anything unreadable falls back to 30 days, previous period, UTC. */
export function readQuery(p: URLSearchParams): OverviewQuery {
  const range = isRange(p.get("range")) ? (p.get("range") as RangeId) : "30d";
  const compare = isCompare(p.get("compare")) ? (p.get("compare") as CompareId) : "previous";
  const tz = isTimeZone(p.get("tz")) ? (p.get("tz") as string) : "UTC";
  const q: OverviewQuery = { range, compare, tz };
  if (range === "custom") {
    const from = p.get("from");
    const to = p.get("to");
    if (isDay(from)) q.from = from;
    if (isDay(to)) q.to = to;
  }
  return q;
}

export function queryString(q: OverviewQuery): string {
  const p = new URLSearchParams({ range: q.range, compare: q.compare, tz: q.tz });
  if (q.range === "custom") {
    if (q.from) p.set("from", q.from);
    if (q.to) p.set("to", q.to);
  }
  return p.toString();
}

function monthStart(day: string): string {
  return day.slice(0, 8) + "01";
}

/** The same calendar day a year earlier (29 February becomes the 28th). */
export function yearEarlier(day: string): string {
  const y = String(Number(day.slice(0, 4)) - 1).padStart(4, "0");
  const md = day.slice(5);
  const candidate = `${y}-${md}`;
  return isDay(candidate) && new Date(candidate + "T00:00:00Z").toISOString().slice(0, 10) === candidate ? candidate : `${y}-02-28`;
}

function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000) + 1;
}

/** The calendar days a query covers, ending no later than today in its zone. */
export function rangeDays(q: OverviewQuery, now = Date.now()): { from: string; to: string } {
  const today = dayInZone(now, q.tz);
  switch (q.range) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "this_month":
      return { from: monthStart(today), to: today };
    case "last_month": {
      const end = addDays(monthStart(today), -1);
      return { from: monthStart(end), to: end };
    }
    case "custom": {
      let from = q.from ?? addDays(today, -29);
      let to = q.to ?? today;
      if (from > to) [from, to] = [to, from];
      if (to > today) to = today;
      if (from > to) from = to;
      if (dayCount(from, to) > MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
      return { from, to };
    }
    default:
      return { from: addDays(today, -29), to: today };
  }
}

export function resolvePeriods(q: OverviewQuery, now = Date.now()): Periods {
  const { from, to } = rangeDays(q, now);
  const current = period(from, to, q.tz);
  let previous: Period;
  if (q.compare === "last_year") {
    previous = period(yearEarlier(from), yearEarlier(to), q.tz);
  } else {
    const n = current.days.length;
    previous = period(addDays(from, -n), addDays(from, -1), q.tz);
  }
  return { range: q.range, compare: q.compare, current, previous };
}

/** A figure and the one it is compared with. pct is null when there is nothing to compare with. */
export interface Delta {
  value: number;
  previous: number;
  diff: number;
  pct: number | null;
}

export function delta(value: number, previous: number): Delta {
  return { value, previous, diff: round2(value - previous), pct: change(value, previous) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Per-currency figures and their comparison. Amounts in different currencies are never added together. */
export type MoneyDelta = Record<string, Delta>;

export function moneyDelta(cur: Record<string, number>, prev: Record<string, number>): MoneyDelta {
  const out: MoneyDelta = {};
  for (const c of [...new Set([...Object.keys(cur), ...Object.keys(prev)])].sort()) {
    out[c] = delta(round2(cur[c] ?? 0), round2(prev[c] ?? 0));
  }
  return out;
}

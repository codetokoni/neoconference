// src/lib/automation/schedule.ts
//
// When an automation rule runs: a cron expression or "every N minutes /
// hours / days", read on the wall clock of the rule's timezone. Pure — no
// KV, safe for client components (the rule editor shows the next runs).
//
// Cron: five fields, minute hour day-of-month month day-of-week, with *,
// lists, ranges, steps and month/day names (Vixie rules: when both day
// fields are restricted, either may match).
//
// Daylight saving, on the wall clock of the zone:
//   - a time that does not exist (02:30 on the spring-forward night) runs at
//     the same distance past the jump — 03:30 — once;
//   - a time that happens twice (01:30 on the fall-back night) runs once, at
//     the first of the two.
// So a daily 09:00 rule stays at 09:00 local all year, and never runs twice
// or not at all on a change night.

import { isValidTimezone, localParts } from "@/lib/zonedTime";

export type ScheduleUnit = "minutes" | "hours" | "days";

export type Schedule =
  | { type: "cron"; expr: string }
  /**
   * minutes: n divides 60 (runs at :00, :n, …); hours: n divides 24, at
   * `minute` past (00:mm, n:mm, …); days: every n days at `at` (HH:MM),
   * counted from `anchorDay` (YYYY-MM-DD, local).
   */
  | { type: "every"; unit: ScheduleUnit; n: number; at?: string; minute?: number; anchorDay?: string };

export const MINUTE_STEPS = [5, 10, 15, 20, 30];
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/* ------------------------------- cron parse ------------------------------- */

interface CronSpec {
  minutes: number[];
  hours: number[];
  dom: Set<number>;
  months: Set<number>; // 1–12
  dow: Set<number>; // 0–6
  domAny: boolean;
  dowAny: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(src: string, lo: number, hi: number, names?: string[], nameBase = 0): number[] {
  const out = new Set<number>();
  const num = (s: string): number => {
    const i = names ? names.indexOf(s.toLowerCase()) : -1;
    if (i >= 0) return i + nameBase;
    if (!/^\d+$/.test(s)) throw new Error(`"${s}" is not a number`);
    return Number(s);
  };
  for (const part of src.split(",")) {
    if (!part) throw new Error("empty list item");
    const [range, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step "${stepStr}"`);
    let a: number;
    let b: number;
    if (range === "*") {
      a = lo;
      b = hi;
    } else if (range.includes("-")) {
      const [x, y] = range.split("-");
      a = num(x);
      b = num(y);
    } else {
      a = num(range);
      b = stepStr === undefined ? a : hi;
    }
    if (a < lo || b > hi || a > b) throw new Error(`${range} is outside ${lo}–${hi}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("A cron expression has five fields: minute hour day month weekday.");
  const label = ["minute", "hour", "day of month", "month", "day of week"];
  const at = <T,>(i: number, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw new Error(`The ${label[i]} field: ${(e as Error).message}.`);
    }
  };
  const minutes = at(0, () => parseField(f[0], 0, 59));
  const hours = at(1, () => parseField(f[1], 0, 23));
  const dom = at(2, () => parseField(f[2], 1, 31));
  const months = at(3, () => parseField(f[3], 1, 12, MONTH_NAMES, 1));
  const dowRaw = at(4, () => parseField(f[4], 0, 7, DAY_NAMES));
  return {
    minutes,
    hours,
    dom: new Set(dom),
    months: new Set(months),
    dow: new Set(dowRaw.map((d) => d % 7)),
    domAny: f[2] === "*" || f[2].startsWith("*/"),
    dowAny: f[4] === "*" || f[4].startsWith("*/"),
  };
}

function dayMatches(c: CronSpec, m: number, d: number, wd: number): boolean {
  if (!c.months.has(m + 1)) return false;
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return c.dow.has(wd);
  if (c.dowAny) return c.dom.has(d);
  return c.dom.has(d) || c.dow.has(wd);
}

/* ---------------------------- wall clock → UTC ---------------------------- */

/**
 * The instant the wall clock in `tz` reads y-m-d h:mi. A time skipped by a
 * spring-forward jump lands the same distance after the jump; a time that
 * happens twice gives the first.
 */
export function wallToInstant(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, m, d, h, mi);
  const offsetAt = (t: number) => {
    const p = localParts(t, tz);
    return Date.UTC(p.y, p.m, p.d, p.h, p.mi) - Math.floor(t / MIN) * MIN;
  };
  // The offsets in force a few hours either side; a wall time maps to an
  // instant under offset o when the zone really is at o then.
  const near = wall - offsetAt(wall);
  const before = offsetAt(near - 6 * 60 * MIN);
  const after = offsetAt(near + 6 * 60 * MIN);
  const valid = [...new Set([before, offsetAt(near), after])].map((o) => wall - o).filter((t) => offsetAt(t) === wall - t);
  if (valid.length) return Math.min(...valid);
  // Skipped by a jump forward: as if the clock had not jumped yet.
  return wall - before;
}

/* -------------------------------- next run -------------------------------- */

const pad = (n: number) => String(n).padStart(2, "0");

function parseHHMM(s: string | undefined): { h: number; mi: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? { h, mi } : null;
}

function parseDay(s: string | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  return m ? { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) } : null;
}

/** The cron expression an every-N-minutes / hours schedule is the same as. */
export function cronFor(s: Schedule): string | null {
  if (s.type === "cron") return s.expr;
  if (s.unit === "minutes") return `*/${s.n} * * * *`;
  if (s.unit === "hours") return `${s.minute ?? 0} */${s.n} * * *`;
  if (s.n === 1) {
    const t = parseHHMM(s.at) ?? { h: 0, mi: 0 };
    return `${t.mi} ${t.h} * * *`;
  }
  return null;
}

const HORIZON_DAYS = 5 * 366;

function nextCron(c: CronSpec, after: number, tz: string): number | null {
  const start = localParts(after, tz);
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    // Calendar arithmetic on the local date, normalised by Date.UTC.
    const day = new Date(Date.UTC(start.y, start.m, start.d + i));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth();
    const d = day.getUTCDate();
    if (!dayMatches(c, m, d, day.getUTCDay())) continue;
    for (const h of c.hours) {
      if (i === 0 && h < start.h - 1) continue; // an hour of slack for a repeated hour
      for (const mi of c.minutes) {
        const t = wallToInstant(y, m, d, h, mi, tz);
        if (t > after) return t;
      }
    }
  }
  return null;
}

function nextEveryDays(s: Extract<Schedule, { type: "every" }>, after: number, tz: string): number | null {
  const t = parseHHMM(s.at) ?? { h: 0, mi: 0 };
  const anchor = parseDay(s.anchorDay);
  const start = localParts(after, tz);
  const anchorUtc = anchor ? Date.UTC(anchor.y, anchor.m, anchor.d) : Date.UTC(start.y, start.m, start.d);
  for (let i = 0; i <= s.n + 2; i++) {
    const dayUtc = Date.UTC(start.y, start.m, start.d + i);
    const since = Math.round((dayUtc - anchorUtc) / DAY);
    if (since < 0 || since % s.n !== 0) continue;
    const day = new Date(dayUtc);
    const at = wallToInstant(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), t.h, t.mi, tz);
    if (at > after) return at;
  }
  // The anchor is in the future and more than n days away.
  if (anchor && anchorUtc > Date.UTC(start.y, start.m, start.d)) return wallToInstant(anchor.y, anchor.m, anchor.d, t.h, t.mi, tz);
  return null;
}

/** The first run strictly after `after`, or null if the schedule never runs. Throws on an invalid schedule. */
export function nextRun(s: Schedule, tz: string, after: number): number | null {
  const err = validateSchedule(s, tz);
  if (err) throw new Error(err);
  if (s.type === "every" && s.unit === "days" && s.n > 1) return nextEveryDays(s, after, tz);
  return nextCron(parseCron(cronFor(s)!), after, tz);
}

/** The next `count` runs after `after`. */
export function upcomingRuns(s: Schedule, tz: string, after: number, count: number): number[] {
  const out: number[] = [];
  let t: number | null = after;
  while (out.length < count && t != null) {
    t = nextRun(s, tz, t);
    if (t != null) out.push(t);
  }
  return out;
}

/**
 * The latest scheduled time at or before `at` — the period a run belongs to,
 * which per-target idempotency keys are named after. Null if none in the
 * last year.
 */
export function previousRun(s: Schedule, tz: string, at: number): number | null {
  for (const window of [60 * MIN, DAY, 8 * DAY, 32 * DAY, 367 * DAY]) {
    let t = nextRun(s, tz, at - window);
    if (t == null || t > at) continue;
    let last = t;
    for (let guard = 0; guard < 10_000; guard++) {
      t = nextRun(s, tz, last);
      if (t == null || t > at) return last;
      last = t;
    }
    return last;
  }
  return null;
}

/* ------------------------------ validation ------------------------------- */

/** A message for the editor, or null if the schedule is valid. */
export function validateSchedule(s: Schedule, tz: string): string | null {
  if (!isValidTimezone(tz)) return `${tz} is not a time zone (use a name like Africa/Lagos or UTC).`;
  if (!s || typeof s !== "object") return "Choose when the rule runs.";
  if (s.type === "cron") {
    if (typeof s.expr !== "string" || !s.expr.trim()) return "Enter a cron expression.";
    try {
      parseCron(s.expr);
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  }
  if (s.type !== "every") return "Choose when the rule runs.";
  if (!Number.isInteger(s.n)) return "Choose how often.";
  if (s.unit === "minutes") return MINUTE_STEPS.includes(s.n) ? null : `Every ${MINUTE_STEPS.join(", ")} minutes.`;
  if (s.unit === "hours") {
    if (!HOUR_STEPS.includes(s.n)) return `Every ${HOUR_STEPS.join(", ")} hours.`;
    return s.minute == null || (Number.isInteger(s.minute) && s.minute >= 0 && s.minute <= 59) ? null : "Minutes past the hour: 0–59.";
  }
  if (s.unit === "days") {
    if (s.n < 1 || s.n > 90) return "Every 1 to 90 days.";
    if (!parseHHMM(s.at)) return "Enter a time like 09:00.";
    if (s.anchorDay !== undefined && !parseDay(s.anchorDay)) return "The start day is a date like 2026-10-12.";
    return null;
  }
  return "Choose minutes, hours or days.";
}

/** Readable form, e.g. "Every day at 09:00 (Africa/Lagos)". */
export function describeSchedule(s: Schedule, tz: string): string {
  const zone = ` (${tz})`;
  if (s.type === "every") {
    if (s.unit === "minutes") return `Every ${s.n} minutes`;
    if (s.unit === "hours") return `Every ${s.n === 1 ? "hour" : `${s.n} hours`} at :${pad(s.minute ?? 0)}${zone}`;
    return `Every ${s.n === 1 ? "day" : `${s.n} days`} at ${s.at ?? "00:00"}${zone}`;
  }
  const f = s.expr.trim().split(/\s+/);
  if (f.length === 5 && /^\d+$/.test(f[0]) && /^\d+$/.test(f[1]) && f[3] === "*") {
    const time = `${pad(Number(f[1]))}:${pad(Number(f[0]))}`;
    if (f[2] === "*" && f[4] === "*") return `Every day at ${time}${zone}`;
    if (f[2] === "*" && /^[0-7]$/.test(f[4])) {
      const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      return `Every ${names[Number(f[4]) % 7]} at ${time}${zone}`;
    }
    if (/^\d+$/.test(f[2]) && f[4] === "*") return `Day ${f[2]} of every month at ${time}${zone}`;
  }
  return `Cron "${s.expr.trim()}"${zone}`;
}

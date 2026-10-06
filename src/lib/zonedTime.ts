// src/lib/zonedTime.ts
//
// Wall-clock time in a named timezone, without a date library. Shared by the
// server (recurrence in src/lib/groupMeetings.ts) and the schedule dialog,
// which reads "10:00 on the 12th" in the meeting's timezone, not the
// browser's.

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  y: number;
  /** 0–11 */
  m: number;
  d: number;
  h: number;
  mi: number;
  /** 0 = Sunday */
  wd: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** What the clock and calendar read in `tz` at instant `ms`. */
export function localParts(ms: number, tz: string): LocalParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month) - 1,
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    wd: WEEKDAYS.indexOf(parts.weekday),
  };
}

/**
 * The instant at which the wall clock in `tz` reads y-m-d h:mi. Days and
 * months past their end roll over, as with Date.UTC.
 */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, m, d, h, mi);
  const offsetAt = (instant: number) => {
    const p = localParts(instant, tz);
    return Date.UTC(p.y, p.m, p.d, p.h, p.mi) - Math.floor(instant / 60_000) * 60_000;
  };
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}

/** "2026-10-12T10:00" (a datetime-local value) read in `tz`, as an ISO instant. */
export function wallTimeToIso(value: string, tz: string): string | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const ms = zonedToUtc(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), tz);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** An instant as a datetime-local value in `tz`. */
export function isoToWallTime(iso: string, tz: string): string {
  const p = localParts(Date.parse(iso), tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

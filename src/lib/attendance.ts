// src/lib/attendance.ts
//
// Attendance capture and aggregation for FRS §4.
//
// Storage
//   neo:attendance:<eventId>:events   Redis list
//     entry = { ts, action, userId, name, email, role, source }
//     action = 'join' | 'leave'
//     source = 'webhook' | 'beacon'  (both wired; either is sufficient)
//
// TTL: 90 days from the most recent append. Long enough to service post-
// meeting reporting; short enough to keep KV usage bounded without a
// scheduled cleanup job.
//
// The list is append-only and unsorted-by-caller — we always sort by ts
// when building the report, since webhooks and beacons can race.
//
// Pure module: no Clerk, no Next, no HTTP. Safe to call from routes,
// webhooks, tests, or a report generator.

import { kv } from "@vercel/kv";
import type { NeoEvent } from "@/types/event";

const RETENTION_SECONDS = 90 * 24 * 60 * 60; // 90 days

export type AttendanceAction = "join" | "leave";
export type AttendanceSource = "webhook" | "beacon";

export interface AttendanceEntry {
  /** Epoch ms. */
  ts: number;
  action: AttendanceAction;
  userId: string | null;
  name: string;
  email?: string;
  /** Wire-format role at the moment the event was recorded. */
  role?: string;
  source: AttendanceSource;
}

function attendanceKey(eventId: string): string {
  return `neo:attendance:${eventId}:events`;
}

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// In-process fallback for tests / unconfigured environments. Same shape as
// the eventStore / meeting-roles fallbacks.
const memStore = new Map<string, AttendanceEntry[]>();

function memBucket(eventId: string): AttendanceEntry[] {
  let b = memStore.get(eventId);
  if (!b) {
    b = [];
    memStore.set(eventId, b);
  }
  return b;
}

/**
 * Append one attendance event. Never throws — attendance is telemetry, and
 * a KV blip should not break the request that would have generated it.
 */
export async function recordAttendance(
  eventId: string,
  entry: Omit<AttendanceEntry, "ts"> & { ts?: number }
): Promise<void> {
  if (!eventId) return;
  const enriched: AttendanceEntry = {
    ...entry,
    ts: entry.ts && Number.isFinite(entry.ts) ? entry.ts : Date.now(),
  };
  if (!isKvConfigured()) {
    memBucket(eventId).push(enriched);
    return;
  }
  try {
    await kv.rpush(attendanceKey(eventId), JSON.stringify(enriched));
    await kv.expire(attendanceKey(eventId), RETENTION_SECONDS);
  } catch (err) {
    console.warn("[attendance] KV write failed", err);
  }
}

async function listAttendance(eventId: string): Promise<AttendanceEntry[]> {
  if (!isKvConfigured()) return memBucket(eventId).slice();
  try {
    const raw = (await kv.lrange(attendanceKey(eventId), 0, -1)) as unknown[];
    const out: AttendanceEntry[] = [];
    for (const r of raw) {
      try {
        if (typeof r === "string") {
          out.push(JSON.parse(r) as AttendanceEntry);
        } else if (r && typeof r === "object") {
          out.push(r as AttendanceEntry);
        }
      } catch {
        // skip malformed rows rather than fail the entire read
      }
    }
    return out;
  } catch (err) {
    console.warn("[attendance] KV read failed", err);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Report shape                                                              */
/* -------------------------------------------------------------------------- */

export type AttendanceStatus = "present" | "left" | "disconnected" | "removed";

export interface AttendanceInterval {
  joinedAt: number;
  leftAt: number | null;
}

export interface AttendanceReportRow {
  fullName: string;
  username: string;
  email: string;
  meetingTitle: string;
  joinedDate: string; // yyyy-mm-dd (first join, UTC)
  joinedTime: string; // hh:mm:ss (first join, UTC)
  leftTime: string;   // hh:mm:ss (last leave, UTC) or ""
  timeZone: string;   // always "UTC" for the report — client can localise
  attendanceDuration: string; // "1h 15m 7s"
  repeatAttendance: boolean;
  numberOfEntries: number;
  role: string;
  attendanceStatus: AttendanceStatus;
  intervals: AttendanceInterval[];
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatUtcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function formatUtcTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * Aggregate raw attendance events into per-user report rows. Multiple entries
 * by the same participant collapse into one row; the underlying join/leave
 * intervals are retained for reference.
 *
 * Grouping key: userId when present, otherwise a normalized name. Beacons and
 * webhooks for the same person merge because the webhook carries the same
 * userId LiveKit's identity is stamped with by the token route.
 */
export function buildAttendanceReport(
  event: Pick<NeoEvent, "name" | "endedAt">,
  entries: AttendanceEntry[]
): AttendanceReportRow[] {
  const meetingTitle = event.name || "";
  const endMs = event.endedAt ? Date.parse(event.endedAt) : NaN;

  // 1. Sort by timestamp so we process joins/leaves in order.
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);

  // 2. Bucket by identity.
  const buckets = new Map<
    string,
    {
      key: string;
      userId: string | null;
      name: string;
      email: string;
      role: string;
      events: AttendanceEntry[];
    }
  >();

  for (const e of sorted) {
    const key = (e.userId || `name:${(e.name || "").trim().toLowerCase()}`) || "unknown";
    let b = buckets.get(key);
    if (!b) {
      b = {
        key,
        userId: e.userId,
        name: e.name || "",
        email: e.email || "",
        role: e.role || "",
        events: [],
      };
      buckets.set(key, b);
    } else {
      // Prefer the most-recent non-empty values so a beacon that fired without
      // an email doesn't blank out a webhook-supplied one.
      if (e.name && e.name.length > 0) b.name = e.name;
      if (e.email && e.email.length > 0) b.email = e.email;
      if (e.role && e.role.length > 0) b.role = e.role;
    }
    b.events.push(e);
  }

  // 3. Turn each bucket into intervals + summary metrics.
  const rows: AttendanceReportRow[] = [];
  for (const b of buckets.values()) {
    const intervals: AttendanceInterval[] = [];
    let openJoin: number | null = null;
    for (const e of b.events) {
      if (e.action === "join") {
        if (openJoin !== null) {
          // Two joins in a row without a leave — close the previous with
          // "unknown" (null leftAt) and open a new one. Better than dropping.
          intervals.push({ joinedAt: openJoin, leftAt: null });
        }
        openJoin = e.ts;
      } else if (e.action === "leave") {
        if (openJoin !== null) {
          intervals.push({ joinedAt: openJoin, leftAt: e.ts });
          openJoin = null;
        } else {
          // Leave without a matching join — beacon fired after a race.
          intervals.push({ joinedAt: e.ts, leftAt: e.ts });
        }
      }
    }
    if (openJoin !== null) {
      // Still open. If the event ended, close at end; otherwise leave null.
      intervals.push({ joinedAt: openJoin, leftAt: Number.isFinite(endMs) ? endMs : null });
    }

    const firstJoin = intervals.length > 0 ? intervals[0].joinedAt : 0;
    const lastLeave = intervals.reduce<number | null>((acc, iv) => {
      if (iv.leftAt === null) return acc;
      return acc === null || iv.leftAt > acc ? iv.leftAt : acc;
    }, null);
    const totalMs = intervals.reduce((acc, iv) => {
      const end = iv.leftAt ?? (Number.isFinite(endMs) ? endMs : iv.joinedAt);
      return acc + Math.max(0, end - iv.joinedAt);
    }, 0);

    const status: AttendanceStatus = (() => {
      const lastEvent = b.events[b.events.length - 1];
      if (!lastEvent) return "disconnected";
      if (lastEvent.action === "leave") return "left";
      // No leave observed. If the meeting has ended treat as disconnected.
      if (Number.isFinite(endMs)) return "disconnected";
      return "present";
    })();

    rows.push({
      fullName: b.name,
      username: b.userId || "",
      email: b.email,
      meetingTitle,
      joinedDate: firstJoin ? formatUtcDate(firstJoin) : "",
      joinedTime: firstJoin ? formatUtcTime(firstJoin) : "",
      leftTime: lastLeave ? formatUtcTime(lastLeave) : "",
      timeZone: "UTC",
      attendanceDuration: formatDuration(totalMs),
      repeatAttendance: intervals.length > 1,
      numberOfEntries: intervals.length,
      role: b.role,
      attendanceStatus: status,
      intervals,
    });
  }

  // 4. Deterministic sort — earliest first-join first.
  return rows.sort((a, b) => {
    const av = a.joinedDate + a.joinedTime;
    const bv = b.joinedDate + b.joinedTime;
    return av.localeCompare(bv);
  });
}

/** Convenience wrapper: fetch + aggregate in one call for the export route. */
export async function fetchAttendanceReport(
  event: NeoEvent
): Promise<AttendanceReportRow[]> {
  const entries = await listAttendance(event.id);
  return buildAttendanceReport(event, entries);
}

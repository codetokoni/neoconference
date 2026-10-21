// src/lib/partners/attendanceMath.ts — how connected time becomes prayer
// time. Pure: no storage, no clock (callers pass `now`).
//
// The policy, in one place (docs/integrations/partner-zones.md):
//   - A connection counts from when LiveKit confirmed it (its join event,
//     or LiveKit's own joinedAt when the page's first heartbeat arrives
//     before that event) until LiveKit reports it gone.
//   - If LiveKit's leave never arrives (a closed lid, a lost network),
//     the connection ends at the page's last heartbeat once no heartbeat
//     has come for HEARTBEAT_EXPIRY_MS.
//   - A person's connections are merged (tabs, devices, reconnects never
//     count twice), and a gap of up to RECONNECT_GRACE_MS between two of
//     their connections counts as connected. A longer gap is not counted.
//     A gap at the end (they left) is never counted.
//   - A closed session caps every connection at its end.

export const RECONNECT_GRACE_MS = 60_000;
/** Pages beat every 20 s; browsers may slow a hidden page's timers to once a minute. */
export const HEARTBEAT_EXPIRY_MS = 150_000;

export type Interval = { start: number; end: number };

/** One LiveKit connection as stored: s = confirmed start, e = confirmed end, l = last heartbeat. */
export type ConnectionRecord = { s: number; e?: number; l?: number };

/** When a connection ended (or `now` if it is still on), and whether it is still on. */
export function connectionEnd(c: ConnectionRecord, now: number, sessionEnd?: number): { end: number; open: boolean } {
  const last = Math.max(c.s, c.l ?? c.s);
  let end: number;
  let open = false;
  if (c.e != null) end = Math.max(c.s, c.e);
  else if (sessionEnd != null) end = Math.min(Math.max(last, c.s), sessionEnd);
  else if (now - last > HEARTBEAT_EXPIRY_MS) end = last;
  else {
    end = Math.max(now, c.s);
    open = true;
  }
  if (sessionEnd != null) end = Math.min(end, sessionEnd);
  return { end: Math.max(end, c.s), open: open && sessionEnd == null };
}

/** Sorted, non-overlapping; intervals closer than `gapMs` are joined. */
export function mergeIntervals(list: Interval[], gapMs = RECONNECT_GRACE_MS): Interval[] {
  const sorted = list.filter((i) => i.end >= i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start - last.end <= gapMs) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** The parts of the intervals inside [from, to). */
export function clipIntervals(list: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  for (const i of list) {
    const start = Math.max(i.start, from);
    const end = Math.min(i.end, to);
    if (end > start) out.push({ start, end });
  }
  return out;
}

export function totalMs(list: Interval[]): number {
  return list.reduce((sum, i) => sum + (i.end - i.start), 0);
}

/**
 * One person's counted time: their connections merged (grace applied
 * before clipping, so a reconnect that straddles the period edge is
 * treated the same way on both sides), then clipped to the period.
 */
export function countedIntervals(raw: Interval[], from = -Infinity, to = Infinity): Interval[] {
  return clipIntervals(mergeIntervals(raw), from, to);
}

import { kv } from "@vercel/kv";

/**
 * Segment / countdown timer for the programme feed.
 *
 * Storage is deliberately absolute: we record when the timer was
 * started and its total duration, not the current remaining time.
 * That way we don't need to write to KV every tick to keep the state
 * fresh; a viewer that arrives 3 minutes in computes the remaining
 * time from the same values the producer stored a full 3 minutes
 * ago. Same trick every browser countdown widget uses; scaled to
 * "every viewer of a live broadcast."
 *
 * `paused` is the frozen remaining time when the timer is paused —
 * unpausing rebuilds `startedAt` such that `remainingMs = paused`,
 * and clears the field.
 *
 * `expiresBehaviour` decides what happens when the countdown hits
 * zero: "hold" leaves the overlay at 00:00 so a moderator sees the
 * segment overran; "hide" collapses the overlay entirely. Producer
 * preference; nothing else in the app cares.
 */
export interface RoomTimer {
  /** Short label shown above the digits ("Testimony", "Prayer"…). */
  label: string;
  /** ms — how long the segment was set to run. */
  durationMs: number;
  /** ms since epoch — when the current run started. Ignored when paused. */
  startedAt: number;
  /**
   * When set, timer is paused; contains ms remaining at pause time.
   * When null / undefined, timer is running from startedAt.
   */
  paused?: number | null;
  /** ms since epoch — last time this record was written. */
  updatedAt: number;
  /** What to do when the countdown expires. */
  expiresBehaviour: "hold" | "hide";
}

export const timerKey = (room: string) => `neo:video:timer:${room}`;

export async function getTimer(room: string): Promise<RoomTimer | null> {
  const t = await kv.get<RoomTimer>(timerKey(room));
  return t ?? null;
}

export async function setTimer(
  room: string,
  input: {
    label: string;
    durationMs: number;
    expiresBehaviour?: "hold" | "hide";
  },
): Promise<RoomTimer> {
  const now = Date.now();
  const timer: RoomTimer = {
    label: input.label.slice(0, 60),
    durationMs: Math.max(1000, Math.floor(input.durationMs)),
    startedAt: now,
    paused: null,
    updatedAt: now,
    expiresBehaviour: input.expiresBehaviour ?? "hold",
  };
  await kv.set(timerKey(room), timer);
  return timer;
}

export async function pauseTimer(room: string): Promise<RoomTimer | null> {
  const t = await getTimer(room);
  if (!t) return null;
  if (typeof t.paused === "number") return t; // already paused
  const now = Date.now();
  const elapsed = now - t.startedAt;
  const remaining = Math.max(0, t.durationMs - elapsed);
  const next: RoomTimer = { ...t, paused: remaining, updatedAt: now };
  await kv.set(timerKey(room), next);
  return next;
}

export async function resumeTimer(room: string): Promise<RoomTimer | null> {
  const t = await getTimer(room);
  if (!t) return null;
  if (t.paused == null) return t; // already running
  const now = Date.now();
  // Rebuild startedAt so remaining time stays exactly what it was
  // when paused. durationMs stays; startedAt shifts.
  const next: RoomTimer = {
    ...t,
    startedAt: now - (t.durationMs - t.paused),
    paused: null,
    updatedAt: now,
  };
  await kv.set(timerKey(room), next);
  return next;
}

export async function clearTimer(room: string): Promise<void> {
  await kv.del(timerKey(room));
}

/**
 * Compute the remaining ms for a timer without mutating KV. Callers
 * (the watch page, the admin control) run this locally so the
 * countdown ticks smoothly between server writes.
 */
export function remainingMs(t: RoomTimer, now = Date.now()): number {
  if (typeof t.paused === "number") return Math.max(0, t.paused);
  return Math.max(0, t.durationMs - (now - t.startedAt));
}

/** true if the timer has counted down past zero. */
export function isExpired(t: RoomTimer, now = Date.now()): boolean {
  return remainingMs(t, now) === 0 && t.paused == null;
}

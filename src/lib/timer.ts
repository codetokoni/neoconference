// src/lib/timer.ts
//
// Server-authoritative timer state for FRS §10 meeting timers.
//
// Storage: neo:timer:<eventId>  (single JSON blob in KV)
//   TTL: 24 hours, refreshed on every write. Timers are ephemeral — no reason
//   to hold state longer than a meeting typically runs.
//
// State model
//
//   status = 'idle'    — no timer configured yet, or just reset
//         = 'running'  — counting down
//         = 'paused'   — held; resumes from the paused-at value
//         = 'expired'  — countdown reached zero; still displayed as 00:00
//
//   Fields are minimal on purpose so late joiners can derive the exact
//   remaining ms from `state + Date.now()` without any additional server
//   fetches:
//
//     durationMs         — the full duration the timer is set to
//     remainingAtStartMs — how much remained when the countdown last started;
//                          equal to durationMs on a fresh start, smaller on
//                          a resume from pause.
//     startedAtMs        — epoch ms when the countdown last started; null
//                          when paused / idle / expired.
//     remainingAtPauseMs — how much remained at the pause moment; only set
//                          while paused.
//
// Clients derive `remaining = computeRemaining(state, now)` — that pure
// helper lives here too so browsers and tests never disagree with the
// server on what "time left" means.

import { kv } from "@vercel/kv";

const TTL_SECONDS = 24 * 60 * 60;

export type TimerStatus = "idle" | "running" | "paused" | "expired";
export type TimerVisibility = "everyone" | "admins";

export interface TimerState {
  status: TimerStatus;
  durationMs: number;
  remainingAtStartMs: number;
  startedAtMs: number | null;
  remainingAtPauseMs: number | null;
  visibility: TimerVisibility;
  updatedAt: number;
}

export const IDLE_TIMER: TimerState = {
  status: "idle",
  durationMs: 0,
  remainingAtStartMs: 0,
  startedAtMs: null,
  remainingAtPauseMs: null,
  visibility: "everyone",
  updatedAt: 0,
};

function timerKey(eventId: string): string {
  return `neo:timer:${eventId}`;
}

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const memStore = new Map<string, TimerState>();

/**
 * Load the current timer state. Returns IDLE_TIMER when no timer has ever
 * been configured for this event — never null, so callers can render the
 * "idle" state without a separate branch.
 */
export async function getTimer(eventId: string): Promise<TimerState> {
  if (!eventId) return { ...IDLE_TIMER };
  if (!isKvConfigured()) {
    return memStore.get(eventId) ?? { ...IDLE_TIMER };
  }
  try {
    const raw = await kv.get(timerKey(eventId));
    if (!raw) return { ...IDLE_TIMER };
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as TimerState;
      } catch {
        return { ...IDLE_TIMER };
      }
    }
    return raw as TimerState;
  } catch (err) {
    console.warn("[timer] KV read failed", err);
    return { ...IDLE_TIMER };
  }
}

async function saveTimer(eventId: string, state: TimerState): Promise<void> {
  const stamped: TimerState = { ...state, updatedAt: Date.now() };
  if (!isKvConfigured()) {
    memStore.set(eventId, stamped);
    return;
  }
  try {
    await kv.set(timerKey(eventId), JSON.stringify(stamped), { ex: TTL_SECONDS });
  } catch (err) {
    console.warn("[timer] KV write failed", err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Pure state transitions                                                    */
/* -------------------------------------------------------------------------- */

const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours — sanity clamp

function clampDuration(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(Math.floor(ms), MAX_DURATION_MS);
}

/**
 * Given a state and a wall-clock time, return the current milliseconds
 * remaining on the countdown. Pure — same answer everywhere.
 */
export function computeRemaining(state: TimerState, now: number = Date.now()): number {
  switch (state.status) {
    case "idle":
    case "expired":
      return state.status === "expired" ? 0 : state.durationMs;
    case "paused":
      return Math.max(0, state.remainingAtPauseMs ?? state.durationMs);
    case "running": {
      const started = state.startedAtMs ?? now;
      const elapsed = Math.max(0, now - started);
      return Math.max(0, state.remainingAtStartMs - elapsed);
    }
  }
}

export function transitionSet(prev: TimerState, durationMs: number, visibility?: TimerVisibility): TimerState {
  const d = clampDuration(durationMs);
  return {
    ...prev,
    status: "idle",
    durationMs: d,
    remainingAtStartMs: d,
    startedAtMs: null,
    remainingAtPauseMs: null,
    visibility: visibility ?? prev.visibility,
    updatedAt: Date.now(),
  };
}

export function transitionStart(prev: TimerState, now: number = Date.now()): TimerState {
  if (prev.durationMs <= 0) return prev;
  return {
    ...prev,
    status: "running",
    remainingAtStartMs: prev.durationMs,
    startedAtMs: now,
    remainingAtPauseMs: null,
    updatedAt: now,
  };
}

export function transitionPause(prev: TimerState, now: number = Date.now()): TimerState {
  if (prev.status !== "running") return prev;
  const remaining = computeRemaining(prev, now);
  return {
    ...prev,
    status: "paused",
    remainingAtPauseMs: remaining,
    startedAtMs: null,
    updatedAt: now,
  };
}

export function transitionResume(prev: TimerState, now: number = Date.now()): TimerState {
  if (prev.status !== "paused") return prev;
  const remaining = prev.remainingAtPauseMs ?? prev.durationMs;
  return {
    ...prev,
    status: "running",
    remainingAtStartMs: remaining,
    startedAtMs: now,
    remainingAtPauseMs: null,
    updatedAt: now,
  };
}

export function transitionReset(prev: TimerState): TimerState {
  return {
    ...prev,
    status: "idle",
    remainingAtStartMs: prev.durationMs,
    startedAtMs: null,
    remainingAtPauseMs: null,
    updatedAt: Date.now(),
  };
}

export function transitionAdjust(prev: TimerState, deltaMs: number, now: number = Date.now()): TimerState {
  if (!Number.isFinite(deltaMs) || deltaMs === 0) return prev;
  const delta = Math.floor(deltaMs);
  switch (prev.status) {
    case "idle":
    case "expired": {
      const nextDuration = clampDuration(prev.durationMs + delta);
      return {
        ...prev,
        status: nextDuration > 0 ? "idle" : "idle",
        durationMs: nextDuration,
        remainingAtStartMs: nextDuration,
        updatedAt: now,
      };
    }
    case "paused": {
      const nextRemaining = Math.max(0, (prev.remainingAtPauseMs ?? prev.durationMs) + delta);
      return {
        ...prev,
        remainingAtPauseMs: nextRemaining,
        durationMs: Math.max(prev.durationMs, nextRemaining),
        updatedAt: now,
      };
    }
    case "running": {
      const remainingNow = computeRemaining(prev, now);
      const nextRemaining = Math.max(0, remainingNow + delta);
      return {
        ...prev,
        remainingAtStartMs: nextRemaining,
        startedAtMs: now,
        durationMs: Math.max(prev.durationMs, nextRemaining),
        updatedAt: now,
      };
    }
  }
}

export function transitionVisibility(prev: TimerState, visibility: TimerVisibility): TimerState {
  return { ...prev, visibility, updatedAt: Date.now() };
}

/* -------------------------------------------------------------------------- */
/*  Applied action                                                            */
/* -------------------------------------------------------------------------- */

export type TimerAction =
  | { action: "set"; durationMs: number; visibility?: TimerVisibility }
  | { action: "start" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "reset" }
  | { action: "adjust"; deltaMs: number }
  | { action: "visibility"; visibility: TimerVisibility };

/**
 * Load, apply, and save. Returns the new state. Never throws for
 * business-logic no-ops (e.g. pause when already paused); the caller
 * should still broadcast because clients may have missed the previous
 * update.
 */
export async function applyTimerAction(eventId: string, action: TimerAction): Promise<TimerState> {
  const prev = await getTimer(eventId);
  const now = Date.now();
  let next = prev;
  switch (action.action) {
    case "set":
      next = transitionSet(prev, action.durationMs, action.visibility);
      break;
    case "start":
      next = transitionStart(prev, now);
      break;
    case "pause":
      next = transitionPause(prev, now);
      break;
    case "resume":
      next = transitionResume(prev, now);
      break;
    case "reset":
      next = transitionReset(prev);
      break;
    case "adjust":
      next = transitionAdjust(prev, action.deltaMs, now);
      break;
    case "visibility":
      next = transitionVisibility(prev, action.visibility);
      break;
  }
  await saveTimer(eventId, next);
  return next;
}

/** Test seam — clears the in-memory fallback store. */
export function __resetInMemoryTimers(): void {
  memStore.clear();
}

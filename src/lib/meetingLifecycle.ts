// src/lib/meetingLifecycle.ts
//
// Ending meetings that already ended.
//
// A NeoEvent becomes 'live' when someone starts it and should become
// 'ended' when LiveKit tells us the room finished. That webhook is the
// primary mechanism and it works — when it arrives. When it does not, the
// event stays 'live' forever: nothing else ever revisits the decision.
// Meetings on the production account were still marked live 128 days
// after they finished, which is how the mobile dashboard ended up
// offering four-month-old rooms as today's meetings.
//
// A webhook can be missed for reasons we cannot control: a subscription
// that was never saved on the LiveKit side, a deploy that was down for
// the one delivery attempt, a signature mismatch (which the handler
// answers 200 to, on purpose, so LiveKit stops retrying). Every one of
// those leaves a permanently wrong row. So the webhook is backed by
// reconciliation: ask LiveKit which rooms actually exist, and end the
// in-progress meetings whose rooms do not.
//
// The reconciler is deliberately conservative. It ends a meeting only
// when LiveKit answered successfully AND the room is absent from that
// answer AND the meeting has been in progress longer than a grace
// period. A failed lookup ends nothing.

import type { NeoEvent, EventState } from "@/types/event";

/**
 * States that mean "this meeting is open right now".
 *
 * 'waiting' belongs here and was the second half of the bug: the
 * room_finished handler only transitioned from 'live', so a meeting whose
 * attendees were still in the waiting room when the room closed could
 * never be ended by the webhook at all.
 */
export const IN_PROGRESS_STATES: readonly EventState[] = ["live", "waiting"];

export function isInProgress(state: EventState): boolean {
  return IN_PROGRESS_STATES.includes(state);
}

/**
 * How long a meeting may be in progress with no LiveKit room before we
 * conclude it is over.
 *
 * Not zero: a meeting is marked live by /api/events/[id]/start, and the
 * LiveKit room is not created until the first participant connects. A
 * sweep in that window would end a meeting seconds after someone opened
 * it. An hour is far longer than that gap and far shorter than the four
 * months these were sitting at.
 */
export const DEFAULT_GRACE_MS = 60 * 60 * 1000;

export interface SweepDecision {
  /** In-progress, room gone, past the grace period: end these. */
  end: NeoEvent[];
  /** In-progress and LiveKit still has the room: leave alone. */
  stillActive: NeoEvent[];
  /** In-progress, room gone, but too recent to be sure. */
  tooRecent: NeoEvent[];
}

/**
 * When a meeting was last known to be going.
 *
 * startedAt is the honest answer where we have it. updatedAt is the
 * fallback, and it is a fallback rather than the primary because any
 * unrelated edit to the event would otherwise keep resetting the clock.
 */
export function inProgressSince(ev: NeoEvent): number | null {
  for (const raw of [ev.startedAt, ev.updatedAt]) {
    const t = Date.parse(raw || "");
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Decide, from a list of events and the set of rooms LiveKit says exist,
 * which meetings are over.
 *
 * Pure on purpose: the judgement is the part worth testing, and it can be
 * tested without LiveKit, without KV and without a network.
 *
 * `activeRooms` must be the result of a *successful* listRooms call.
 * Passing an empty set because the call failed would end every meeting on
 * the account, so callers must not do that — see sweepStaleMeetings.
 */
export function decideSweep(params: {
  events: NeoEvent[];
  activeRooms: Set<string>;
  now: number;
  graceMs?: number;
}): SweepDecision {
  const { events, activeRooms, now } = params;
  const graceMs = params.graceMs ?? DEFAULT_GRACE_MS;

  const decision: SweepDecision = { end: [], stillActive: [], tooRecent: [] };

  for (const ev of events) {
    if (!isInProgress(ev.state)) continue;

    const room = (ev.livekitRoom || ev.slug || "").toLowerCase();
    if (room && activeRooms.has(room)) {
      decision.stillActive.push(ev);
      continue;
    }

    const since = inProgressSince(ev);
    // No usable timestamp means no way to tell how long it has been open,
    // and guessing would risk ending a meeting that started a minute ago.
    if (since === null || now - since < graceMs) {
      decision.tooRecent.push(ev);
      continue;
    }

    decision.end.push(ev);
  }

  return decision;
}

/**
 * The best honest end time we have.
 *
 * We do not know when the room actually closed — that is precisely the
 * information the missing webhook would have carried. updatedAt is the
 * last moment we know something was true about this meeting, so it is
 * used rather than "now", which would claim a meeting that finished in
 * May ended today.
 */
export function inferredEndedAt(ev: NeoEvent): string {
  return ev.endedAt || ev.updatedAt || new Date().toISOString();
}

export interface SweepSummary {
  ok: boolean;
  scanned: number;
  ended: number;
  stillActive: number;
  tooRecent: number;
  failed: number;
  endedSlugs: string[];
  /** Set when LiveKit could not be reached; nothing is changed. */
  error?: string;
}

/**
 * Run the reconciliation.
 *
 * Fails closed: if LiveKit cannot be asked which rooms exist, no meeting
 * is touched and the summary says why. The alternative — treating an
 * error as "no rooms are active" — would end every meeting on the
 * account, which is a far worse failure than leaving them stale.
 */
export async function sweepStaleMeetings(deps: {
  listAll: () => Promise<NeoEvent[]>;
  listActiveRooms: () => Promise<string[]>;
  endMeeting: (ev: NeoEvent) => Promise<void>;
  now?: number;
  graceMs?: number;
}): Promise<SweepSummary> {
  const now = deps.now ?? Date.now();

  const events = await deps.listAll();
  const candidates = events.filter((ev) => isInProgress(ev.state));

  const base: SweepSummary = {
    ok: true,
    scanned: candidates.length,
    ended: 0,
    stillActive: 0,
    tooRecent: 0,
    failed: 0,
    endedSlugs: [],
  };

  if (candidates.length === 0) return base;

  let activeRooms: Set<string>;
  try {
    const names = await deps.listActiveRooms();
    activeRooms = new Set(
      names.map((n) => (n || "").toLowerCase()).filter((n) => n.length > 0)
    );
  } catch (e) {
    return {
      ...base,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const decision = decideSweep({
    events: candidates,
    activeRooms,
    now,
    graceMs: deps.graceMs,
  });

  base.stillActive = decision.stillActive.length;
  base.tooRecent = decision.tooRecent.length;

  for (const ev of decision.end) {
    try {
      await deps.endMeeting(ev);
      base.ended += 1;
      base.endedSlugs.push(ev.slug);
    } catch {
      // One event failing to write must not stop the rest being fixed.
      base.failed += 1;
    }
  }

  return base;
}

// src/lib/viewerPhase.ts
//
// What a viewer of a live room is shown, decided in one place so the player
// can never leave an unexplained black screen. Pure: the player feeds it
// what it knows and draws the answer.

export type ViewerPhase = "playing" | "waiting" | "connecting" | "reconnecting" | "blocked";

export interface PhaseInput {
  /** The first /api/video/status answer has arrived. */
  statusKnown: boolean;
  /** The server says the room's broadcaster is publishing. */
  broadcasterLive: boolean;
  /** The broadcaster connection's own state. */
  conn: "connecting" | "waiting" | "playing" | "reconnecting";
  /** Frames are arriving from the broadcaster right now. */
  hasPicture: boolean;
  /** This viewer has had the broadcast before (on this page visit). */
  everPlayed: boolean;
  /** Connected and live, yet no frames for too long — a failed subscription. */
  stalled: boolean;
  /** The browser refused to start playback without a tap. */
  playBlocked: boolean;
}

export function viewerPhase(i: PhaseInput): ViewerPhase {
  if (i.hasPicture && !i.stalled) return i.playBlocked ? "blocked" : "playing";
  // Not live (by the server's word, or AMS has no such stream yet before the
  // server has answered): say so, never a bare black frame.
  if (i.statusKnown ? !i.broadcasterLive : i.conn === "waiting") return "waiting";
  if (i.playBlocked) return "blocked";
  if (i.everPlayed || i.stalled || i.conn === "reconnecting") return "reconnecting";
  return "connecting";
}

export const PHASE_TEXT: Record<Exclude<ViewerPhase, "playing" | "blocked">, string> = {
  waiting: "Waiting for the host’s live broadcast.",
  connecting: "Connecting to the live broadcast…",
  reconnecting: "Reconnecting to the live broadcast.",
};

/** No frames for this long while live and connected means the subscription failed: start it again. */
export const STALL_MS = 10_000;
/** And not more often than this, so a dead encoder doesn't make every viewer reconnect in a loop. */
export const RESTART_EVERY_MS = 15_000;

export function shouldRestart(opts: {
  now: number;
  lastFrameAt: number;
  lastRestartAt: number;
  live: boolean;
  connected: boolean;
}): boolean {
  if (!opts.live || !opts.connected) return false;
  return opts.now - opts.lastFrameAt >= STALL_MS && opts.now - opts.lastRestartAt >= RESTART_EVERY_MS;
}

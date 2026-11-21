// src/lib/connectOutcome.ts
//
// Telling a join that never got in apart from leaving a meeting.
//
// When LiveKit refuses a connection (the whole account full, a network that
// cannot reach it), livekit-client still emits Disconnected, without
// Connected ever having come. The room used to treat every Disconnected as
// leaving and send the person to the after-meeting page: refused at the door,
// it looked exactly like being thrown out. Now a Disconnected before any
// Connected is a join that failed, and the room asks the server whether the
// service is full (/api/livekit/capacity) to say which.
//
// No React and no LiveKit import: safe anywhere, testable with the real
// livekit-client in a browser.

import { SERVICE_FULL_MESSAGE } from "@/lib/livekitCapacity";

export interface ConnectWatch {
  /** For the room's Connected event. */
  onConnected: () => void;
  /** For the room's Disconnected event. */
  onDisconnected: () => void;
}

/**
 * Handlers for a room's Connected and Disconnected events: a disconnect after
 * the room connected is leaving (or being removed); one before it ever did is
 * a join that failed. Getters, so the latest handlers are always the ones
 * called.
 */
export function connectWatch(handlers: () => { onLeave: () => void; onJoinFailed: () => void }): ConnectWatch {
  let connected = false;
  return {
    onConnected: () => {
      connected = true;
    },
    onDisconnected: () => {
      const h = handlers();
      if (connected) h.onLeave();
      else h.onJoinFailed();
    },
  };
}

export interface JoinProblem {
  /** The meeting (or the whole service) is full: "Meeting full". */
  full: boolean;
  message: string;
}

export const COULD_NOT_CONNECT = "We couldn't connect you to the meeting. Check your connection and try again.";

/**
 * Why a join that never got in failed: full, when the server says the service
 * is full now; otherwise a connection problem. Never throws.
 */
export async function explainConnectFailure(fetchImpl: typeof fetch = fetch): Promise<JoinProblem> {
  try {
    const res = await fetchImpl("/api/livekit/capacity", { cache: "no-store" });
    const body = res.ok ? ((await res.json()) as { full?: unknown; message?: unknown }) : null;
    if (body?.full === true) {
      return { full: true, message: typeof body.message === "string" && body.message ? body.message : SERVICE_FULL_MESSAGE };
    }
  } catch {
    // Could not ask: say what is certain, that it did not connect.
  }
  return { full: false, message: COULD_NOT_CONNECT };
}

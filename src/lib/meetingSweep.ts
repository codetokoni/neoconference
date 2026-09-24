// src/lib/meetingSweep.ts
//
// The reconciler, wired to the real LiveKit and the real event store.
//
// src/lib/meetingLifecycle.ts holds the judgement and knows nothing about
// either; this file supplies them, and adds the throttle that lets the
// sweep be triggered by ordinary reads without doing a LiveKit round trip
// on every one.

import { RoomServiceClient } from "livekit-server-sdk";
import { kv } from "@vercel/kv";
import { eventStore } from "@/lib/eventStore";
import {
  sweepStaleMeetings,
  inferredEndedAt,
  type SweepSummary,
} from "@/lib/meetingLifecycle";

const THROTTLE_KEY = "neo:meetings:lastSweepAt";

/**
 * How often a read-triggered sweep may actually run.
 *
 * The sweep is one listRooms call plus a write per genuinely-finished
 * meeting, and it is awaited by whichever request happens to trip the
 * throttle. Five minutes keeps that cost to roughly one slightly slower
 * request per five minutes while still clearing a stale room long before
 * anyone notices it. Background work is not used because a serverless
 * function can be frozen the moment it responds, which would leave the
 * sweep half-done and the throttle already taken.
 */
export const SWEEP_THROTTLE_MS = 5 * 60 * 1000;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function livekitClient(): RoomServiceClient | null {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl =
    process.env.NEXT_PUBLIC_LIVEKIT_URL ||
    process.env.LIVEKIT_WS_URL ||
    process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !wsUrl) return null;
  const httpUrl = wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  return new RoomServiceClient(httpUrl, apiKey, apiSecret);
}

/** Run the sweep now, regardless of the throttle. */
export async function runMeetingSweep(options?: {
  graceMs?: number;
  now?: number;
}): Promise<SweepSummary> {
  const svc = livekitClient();
  if (!svc) {
    return {
      ok: false,
      scanned: 0,
      ended: 0,
      stillActive: 0,
      tooRecent: 0,
      failed: 0,
      endedSlugs: [],
      error: "livekit_misconfigured",
    };
  }

  return sweepStaleMeetings({
    listAll: () => eventStore.listAll(),
    listActiveRooms: async () => {
      const rooms = await svc.listRooms();
      return (rooms || []).map((r) => r.name || "");
    },
    endMeeting: async (ev) => {
      await eventStore.update(ev.id, (prev) => ({
        ...prev,
        state: "ended",
        endedAt: inferredEndedAt(prev),
        updatedAt: new Date().toISOString(),
      }));
    },
    graceMs: options?.graceMs,
    now: options?.now,
  });
}

/**
 * Run the sweep if nobody has run it recently.
 *
 * Returns null when the throttle said no, so callers can tell "nothing to
 * do" from "swept and found nothing". Never throws: this is called from
 * the path that lists someone's meetings, and a LiveKit outage must not
 * turn their dashboard into an error page.
 */
export async function maybeSweepMeetings(): Promise<SweepSummary | null> {
  if (!isKvConfigured()) return null;

  try {
    // Claim the window before doing the work, so two requests arriving
    // together do not both sweep. NX + PX means the key is only taken if
    // it is free, and it frees itself when the window expires.
    const claimed = await kv.set(THROTTLE_KEY, Date.now(), {
      nx: true,
      px: SWEEP_THROTTLE_MS,
    });
    if (!claimed) return null;
  } catch {
    // If the throttle cannot be read or written, do nothing rather than
    // sweeping on every request.
    return null;
  }

  try {
    return await runMeetingSweep();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[meetingSweep] sweep failed", e);
    return null;
  }
}

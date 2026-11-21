// src/lib/livekitCapacity.ts
//
// How many people the whole LiveKit account can hold at once, and refusing a
// join clearly when it is full.
//
// LiveKit Cloud caps concurrent connections across the account (every room,
// recording and translation agent together): 1,000 on the Ship plan. Past it,
// LiveKit refuses the connection itself and the room shows a vague connection
// error that people read as being thrown out. So before handing out a token,
// the join routes count everyone connected (listRooms, summed) and, when the
// account is full, say so in words instead. Each meeting's own cap (the
// owner's plan) is a separate check.
//
// A few places are kept back for Owners, Hosts and Moderators, so whoever is
// running a meeting can still get in to run it.
//
// The count is read at most every few seconds per server instance, with a
// short timeout. If it cannot be read, nobody is refused (fail open).

import type { RoomServiceClient } from "livekit-server-sdk";

/** LiveKit's account-wide connection limit (Ship: 1,000). LIVEKIT_MAX_CONCURRENT overrides it. */
export function accountLimit(): number {
  const n = Number(process.env.LIVEKIT_MAX_CONCURRENT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

/** Places kept back for the people running meetings (and recordings and agents). */
export const RESERVED_PLACES = 20;

/** Admin → Ops alerts warns from this many connected (the default rule). */
export const WARN_AT = 800;

export const SERVICE_FULL_MESSAGE =
  "This meeting is full right now: the most people we can connect at once are already connected. " +
  "Please try again in a few minutes.";

export interface CapacityRefusal {
  /**
   * "room_full", the code every app version already shows as a full meeting
   * (with this message); `scope` says it is the whole service, not the room.
   */
  error: "room_full";
  scope: "service";
  message: string;
  connected: number;
  limit: number;
}

/**
 * Whether to refuse a join with `connected` people already on the account.
 * Ordinary joiners stop RESERVED_PLACES short of the limit; the people
 * running meetings may use those, up to the limit itself.
 */
export function capacityRefusal(connected: number | null, elevated: boolean, limit = accountLimit()): CapacityRefusal | null {
  if (connected == null || !Number.isFinite(connected)) return null;
  const stopAt = elevated ? limit : Math.max(0, limit - RESERVED_PLACES);
  if (connected < stopAt) return null;
  return { error: "room_full", scope: "service", message: SERVICE_FULL_MESSAGE, connected, limit };
}

/** How long one count is reused, per server instance. */
const FRESH_MS = 5_000;
/** A count slower than this is skipped (the join goes ahead). */
const TIMEOUT_MS = 2_000;

let last: { at: number; connected: number } | null = null;

/** Tests only: forget the reused count. */
export function __resetConnectedCache(): void {
  last = null;
}

/** Everyone connected across the account, or null when LiveKit cannot be read in time. */
export async function connectedNow(svc: Pick<RoomServiceClient, "listRooms">, now = Date.now()): Promise<number | null> {
  if (last && now - last.at < FRESH_MS) return last.connected;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rooms = await Promise.race([
      svc.listRooms(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    const connected = (rooms ?? []).reduce((n, r) => n + Number((r as { numParticipants?: number }).numParticipants ?? 0), 0);
    last = { at: now, connected };
    return connected;
  } catch (e) {
    console.warn("[livekit-capacity] could not count connections", e instanceof Error ? e.message : e);
    return null;
  }
}

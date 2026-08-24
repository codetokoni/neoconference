// src/lib/hiddenVideos.ts
//
// Per-event set of participants whose video the moderation staff has
// hidden from all viewers. The participant's camera stays on — this is
// display-only suppression, not a track mute.
//
// Storage
//   neo:meeting:<eventId>:hidden-videos   Redis hash
//     field  = participant identity (Clerk userId, LiveKit identity, or
//              a resolved email for guests — whatever the client publishes
//              as its LiveKit identity)
//     value  = "1"
//
// A hash rather than a set so future per-hide metadata (who hid, when,
// reason) can be added without a data migration.
//
// Late joiners fetch this state via /api/events/hide-video on room mount.
// Live updates are broadcast over the LiveKit data channel by the moderator
// who made the change — the server does not push messages of its own.
//
// Pure module: no Next, no HTTP. Safe from routes, tests, background jobs.

import { kv } from "@vercel/kv";

const RETENTION_SECONDS = 30 * 24 * 60 * 60; // 30 days — same order as the roles hash

function hiddenKey(eventId: string): string {
  return `neo:meeting:${eventId}:hidden-videos`;
}

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// In-process fallback for tests and unconfigured environments. Matches the
// pattern used in eventStore / meeting-roles / attendance.
const memoryStore = new Map<string, Set<string>>();

function memGet(eventId: string): Set<string> {
  let s = memoryStore.get(eventId);
  if (!s) {
    s = new Set<string>();
    memoryStore.set(eventId, s);
  }
  return s;
}

/** Read the current hidden set for an event. */
export async function getHiddenVideos(eventId: string): Promise<string[]> {
  if (!isKvConfigured()) {
    return Array.from(memGet(eventId));
  }
  const map = (await kv.hgetall<Record<string, string>>(hiddenKey(eventId))) || {};
  return Object.keys(map);
}

/** Mark a participant's video hidden. Idempotent. */
export async function hideVideo(eventId: string, identity: string): Promise<void> {
  const id = identity.trim();
  if (!id) return;
  if (!isKvConfigured()) {
    memGet(eventId).add(id);
    return;
  }
  await kv.hset(hiddenKey(eventId), { [id]: "1" });
  await kv.expire(hiddenKey(eventId), RETENTION_SECONDS);
}

/** Reveal a previously-hidden participant. Idempotent. */
export async function showVideo(eventId: string, identity: string): Promise<void> {
  const id = identity.trim();
  if (!id) return;
  if (!isKvConfigured()) {
    memGet(eventId).delete(id);
    return;
  }
  await kv.hdel(hiddenKey(eventId), id);
}

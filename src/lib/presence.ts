// src/lib/presence.ts
//
// Which meeting someone is in right now, as their room says every minute.
//
//   neo:presence:<uid>   JSON { eventSlug, eventId, ts }, 90-second TTL
//
// The room sends it every 60 s while connected and deletes it on leaving, so
// a closed tab drops out within 90 s. The ring engine uses it to leave alone
// people already in the meeting, and to tell people in another meeting that
// a call is waiting instead of ringing over it.

import { kv } from "@vercel/kv";

export const PRESENCE_TTL_SECONDS = 90;

export interface Presence {
  eventSlug: string;
  eventId: string;
  /** Epoch ms of the last report. */
  ts: number;
}

const key = (uid: string) => `neo:presence:${uid}`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const mem = new Map<string, Presence>();

export async function setPresence(uid: string, p: Presence): Promise<void> {
  if (!isKvConfigured()) {
    mem.set(uid, p);
    return;
  }
  await kv.set(key(uid), JSON.stringify(p), { ex: PRESENCE_TTL_SECONDS });
}

export async function clearPresence(uid: string): Promise<void> {
  if (!isKvConfigured()) {
    mem.delete(uid);
    return;
  }
  await kv.del(key(uid));
}

/** Where this person is, or null; the in-memory copy ages out like the KV key. */
export async function getPresence(uid: string, now: number = Date.now()): Promise<Presence | null> {
  if (!isKvConfigured()) {
    const p = mem.get(uid);
    return p && now - p.ts < PRESENCE_TTL_SECONDS * 1000 ? p : null;
  }
  const raw = await kv.get(key(uid));
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.eventSlug !== "string" || typeof r.eventId !== "string") return null;
  return { eventSlug: r.eventSlug, eventId: r.eventId, ts: typeof r.ts === "number" ? r.ts : 0 };
}

// src/lib/eventStore.ts
// Vercel KV-backed durable store for NeoEvents.
// Keys:
//   neo:event:<id>          -> NeoEvent JSON
//   neo:slug:<slug>         -> id   (slug -> id index)
//   neo:owner:<userId>      -> Set of event ids
//   neo:events:all          -> Set of all event ids (for admin/list)
//
// When KV env vars are missing (preview/local), falls back to an in-process
// Map so the app still runs and the developer sees clear console warnings.

import { kv } from '@vercel/kv';
import type { NeoEvent } from '@/types/event';

const PREFIX = 'neo:event:';
const SLUG = 'neo:slug:';
const OWNER = 'neo:owner:';
const ALL = 'neo:events:all';

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  );
}

// In-memory fallback (per-process, NOT durable across deploys / lambdas).
// Used only when Vercel KV is not configured.
const memEvents = new Map<string, NeoEvent>();
const memSlug = new Map<string, string>();
const memOwner = new Map<string, Set<string>>();

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[neo:eventStore] Vercel KV is not configured (KV_REST_API_URL / KV_REST_API_TOKEN missing). ' +
    'Falling back to in-memory storage. Events will NOT survive restarts.'
  );
}

export interface CreateEventInput {
  id: string;
  slug: string;
  event: NeoEvent;
}

export const eventStore = {
  isConfigured: isKvConfigured,

  async create(e: NeoEvent): Promise<NeoEvent> {
    if (!isKvConfigured()) {
      warnOnce();
      memEvents.set(e.id, e);
      memSlug.set(e.slug, e.id);
      const set = memOwner.get(e.ownerUserId) ?? new Set<string>();
      set.add(e.id);
      memOwner.set(e.ownerUserId, set);
      return e;
    }
    await kv.set(PREFIX + e.id, e);
    await kv.set(SLUG + e.slug, e.id);
    await kv.sadd(OWNER + e.ownerUserId, e.id);
    await kv.sadd(ALL, e.id);
    return e;
  },

  async byId(id: string): Promise<NeoEvent | null> {
    if (!isKvConfigured()) {
      return memEvents.get(id) ?? null;
    }
    const v = await kv.get<NeoEvent>(PREFIX + id);
    return v ?? null;
  },

  async bySlug(slug: string): Promise<NeoEvent | null> {
    if (!isKvConfigured()) {
      const id = memSlug.get(slug);
      if (!id) return null;
      return memEvents.get(id) ?? null;
    }
    const id = await kv.get<string>(SLUG + slug);
    if (!id) return null;
    return await this.byId(id);
  },

  async update(
    id: string,
    patch: Partial<NeoEvent> | ((prev: NeoEvent) => NeoEvent)
  ): Promise<NeoEvent | null> {
    const prev = await this.byId(id);
    if (!prev) return null;
    const next: NeoEvent =
      typeof patch === 'function'
        ? (patch as (p: NeoEvent) => NeoEvent)(prev)
        : { ...prev, ...patch, updatedAt: new Date().toISOString() };
    if (!isKvConfigured()) {
      memEvents.set(id, next);
      // re-index slug if it changed
      if (prev.slug !== next.slug) {
        memSlug.delete(prev.slug);
        memSlug.set(next.slug, id);
      }
      return next;
    }
    await kv.set(PREFIX + id, next);
    if (prev.slug !== next.slug) {
      await kv.del(SLUG + prev.slug);
      await kv.set(SLUG + next.slug, id);
    }
    return next;
  },

  async listByOwner(userId: string): Promise<NeoEvent[]> {
    if (!isKvConfigured()) {
      const ids = Array.from(memOwner.get(userId) ?? []);
      return ids
        .map((id) => memEvents.get(id))
        .filter((x): x is NeoEvent => Boolean(x));
    }
    const ids = (await kv.smembers(OWNER + userId)) as string[];
    if (!ids || ids.length === 0) return [];
    const events = await Promise.all(
      ids.map((id) => kv.get<NeoEvent>(PREFIX + id))
    );
    return events.filter((x): x is NeoEvent => Boolean(x));
  },

  /**
   * Returns all events sorted by updatedAt DESC (newest activity first).
   * `limit` is optional — when omitted, returns every event. Pre-MVP we
   * read all event records in parallel; past ~10K events this should move
   * to indexed Redis sets. Used by /api/admin/events (no limit) and by
   * legacy callers that pass an explicit cap.
   */
  async listAll(limit?: number): Promise<NeoEvent[]> {
    let events: NeoEvent[];
    if (!isKvConfigured()) {
      events = Array.from(memEvents.values());
    } else {
      const ids = (await kv.smembers(ALL)) as string[];
      if (!ids || ids.length === 0) return [];
      const raw = await Promise.all(ids.map((id) => kv.get<NeoEvent>(PREFIX + id)));
      events = raw.filter((x): x is NeoEvent => Boolean(x));
    }
    events.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return typeof limit === "number" ? events.slice(0, limit) : events;
  },

  async rename(
    id: string,
    newSlug: string
  ): Promise<{ ok: true; event: NeoEvent } | { ok: false; error: string }> {
    const prev = await this.byId(id);
    if (!prev) return { ok: false, error: 'not_found' };
    if (prev.slug === newSlug) return { ok: true, event: prev };
    // Reject if newSlug already maps to a different event.
    if (!isKvConfigured()) {
      const existingId = memSlug.get(newSlug);
      if (existingId && existingId !== id) {
        return { ok: false, error: 'slug_taken' };
      }
    } else {
      const existingId = await kv.get<string>(SLUG + newSlug);
      if (existingId && existingId !== id) {
        return { ok: false, error: 'slug_taken' };
      }
    }
    const aliasSlugs = Array.from(
      new Set([...(prev.aliasSlugs || []), prev.slug].filter((s) => s !== newSlug))
    );
    const next: NeoEvent = {
      ...prev,
      slug: newSlug,
      livekitRoom: newSlug,
      aliasSlugs,
      updatedAt: new Date().toISOString(),
    };
    if (!isKvConfigured()) {
      memEvents.set(id, next);
      // Keep the old slug pointing at the same id so old links still resolve.
      memSlug.set(prev.slug, id);
      memSlug.set(newSlug, id);
      return { ok: true, event: next };
    }
    await kv.set(PREFIX + id, next);
    await kv.set(SLUG + newSlug, id);
    // Intentionally do NOT delete SLUG + prev.slug — old links keep working as aliases.
    await kv.set(SLUG + prev.slug, id);
    return { ok: true, event: next };
  },

  async delete(id: string): Promise<boolean> {
    const prev = await this.byId(id);
    if (!prev) return false;
    const allSlugs = [prev.slug, ...((prev.aliasSlugs || []) as string[])];
    if (!isKvConfigured()) {
      memEvents.delete(id);
      for (const s of allSlugs) memSlug.delete(s);
      memOwner.get(prev.ownerUserId)?.delete(id);
      return true;
    }
    await kv.del(PREFIX + id);
    for (const s of allSlugs) await kv.del(SLUG + s);
    await kv.srem(OWNER + prev.ownerUserId, id);
    await kv.srem(ALL, id);
    return true;
  },
};

// ----- helpers -----

export function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 6);
  return (base || 'event') + '-' + suffix;
}

export function generateId(): string {
  // RFC4122-ish (good enough for event ids).
  const r = () => Math.random().toString(16).slice(2, 10);
  return r() + '-' + r().slice(0, 4) + '-' + r().slice(0, 4) + '-' + r();
}

export function generateQrSeed(): string {
  return Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
}

// Adopt an "orphan" room (one with no backing event record) by creating a
// minimal event record with the first authenticated caller as host/owner.
// Shared between /api/events/role and /api/livekit/token so both routes agree
// on who is host for instant-meeting / direct-link rooms.
export async function adoptOrphanRoom(slug: string, userId: string, email?: string): Promise<NeoEvent | null> {
  const now = new Date().toISOString();
  const ev: NeoEvent = {
    id: generateId(),
    slug,
    name: slug,
    ownerUserId: userId,
    ownerEmail: email,
    visibility: 'unlisted',
    waitingRoomEnabled: false,
    livekitRoom: slug,
    hsmoh: { shortCode: slug, shortUrl: '/e/' + slug, fallback: true },
    qrSeed: generateQrSeed(),
    roles: [],
    waitingRoom: [],
    recordings: [],
    state: 'live',
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await eventStore.create(ev);
    return ev;
  } catch (e) {
    // Race: another request may have just created it. Re-read and use whatever
    // exists rather than failing.
    console.warn('[eventStore] adoptOrphanRoom create failed, re-reading', e);
    return await eventStore.bySlug(slug);
  }
}


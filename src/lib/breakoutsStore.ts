// src/lib/breakoutsStore.ts
// Vercel KV-backed durable store for breakout-room state, keyed by event slug.
//
// Mirrors the shape of eventStore: KV when configured, in-process Map fallback
// (with a one-time console warning) when KV env vars are missing.
//
// Key layout:
//   neo:breakouts:<slug> -> BreakoutState JSON

import { kv } from '@vercel/kv';

export interface BreakoutGroup {
  id: string;
  name: string;
}

export interface BreakoutState {
  active: boolean;
  groups: BreakoutGroup[];
  /** identity -> groupId */
  assignments: Record<string, string>;
  ts: number;
}

const PREFIX = 'neo:breakouts:';

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  );
}

const memStore = new Map<string, BreakoutState>();

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[neo:breakoutsStore] Vercel KV is not configured (KV_REST_API_URL / KV_REST_API_TOKEN missing). ' +
      'Falling back to in-memory storage. Breakout state will NOT survive restarts.'
  );
}

export const breakoutsStore = {
  isConfigured: isKvConfigured,

  async get(slug: string): Promise<BreakoutState | null> {
    if (!isKvConfigured()) {
      warnOnce();
      return memStore.get(slug) ?? null;
    }
    const v = await kv.get<BreakoutState>(PREFIX + slug);
    return v ?? null;
  },

  async set(slug: string, state: BreakoutState): Promise<BreakoutState> {
    if (!isKvConfigured()) {
      warnOnce();
      memStore.set(slug, state);
      return state;
    }
    await kv.set(PREFIX + slug, state);
    return state;
  },

  async clear(slug: string): Promise<boolean> {
    if (!isKvConfigured()) {
      return memStore.delete(slug);
    }
    const n = await kv.del(PREFIX + slug);
    return n > 0;
  },
};

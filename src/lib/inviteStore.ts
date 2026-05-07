// src/lib/inviteStore.ts
//
// KV-backed persistence for InviteToken objects. Each token is a single
// document keyed by neo:invite:<token>. We also keep a per-event index at
// neo:invites:<eventId> so the dashboard can list all outstanding invites.
//
// Falls back to an in-memory Map per-process when Vercel KV is not configured.

import { kv } from '@vercel/kv';
import type { InviteToken } from '@/types/event';

const TOKEN_PREFIX = 'neo:invite:';
const INDEX_PREFIX = 'neo:invites:';

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  );
}

const memTokens = new Map<string, InviteToken>();
const memIndex = new Map<string, string[]>();

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[neo:inviteStore] Vercel KV is not configured - invites are kept in-memory only.'
  );
}

function tk(token: string): string { return TOKEN_PREFIX + token; }
function ik(eventId: string): string { return INDEX_PREFIX + eventId; }

function rndToken(): string {
  // 22-char URL-safe token (~128 bits)
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export const inviteStore = {
  isConfigured: isKvConfigured,
  newToken: rndToken,

  async create(invite: Omit<InviteToken, "token" | "createdAt" | "uses">): Promise<InviteToken> {
    const full: InviteToken = {
      ...invite,
      token: rndToken(),
      createdAt: new Date().toISOString(),
      uses: 0,
      maxUses: invite.maxUses && invite.maxUses > 0 ? invite.maxUses : 1,
    };
    if (!isKvConfigured()) {
      warnOnce();
      memTokens.set(full.token, full);
      const arr = memIndex.get(full.eventId) ?? [];
      arr.unshift(full.token);
      memIndex.set(full.eventId, arr);
      return full;
    }
    await kv.set(tk(full.token), full);
    const arr = (await kv.get<string[]>(ik(full.eventId))) ?? [];
    arr.unshift(full.token);
    while (arr.length > 200) arr.pop();
    await kv.set(ik(full.eventId), arr);
    return full;
  },

  async get(token: string): Promise<InviteToken | null> {
    if (!isKvConfigured()) return memTokens.get(token) ?? null;
    try {
      const v = await kv.get<InviteToken>(tk(token));
      return v ?? null;
    } catch { return null; }
  },

  async listForEvent(eventId: string): Promise<InviteToken[]> {
    if (!isKvConfigured()) {
      const ids = memIndex.get(eventId) ?? [];
      return ids.map((t) => memTokens.get(t)!).filter(Boolean);
    }
    const ids = (await kv.get<string[]>(ik(eventId))) ?? [];
    if (ids.length === 0) return [];
    const out: InviteToken[] = [];
    for (const id of ids) {
      const v = await kv.get<InviteToken>(tk(id));
      if (v) out.push(v);
    }
    return out;
  },

  /** Atomically increments uses; returns updated token or null if not redeemable. */
  async redeem(token: string): Promise<InviteToken | null> {
    const inv = await this.get(token);
    if (!inv) return null;
    if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) return null;
    if (inv.uses >= inv.maxUses) return null;
    const updated: InviteToken = { ...inv, uses: inv.uses + 1 };
    if (!isKvConfigured()) {
      memTokens.set(token, updated);
      return updated;
    }
    try { await kv.set(tk(token), updated); } catch {}
    return updated;
  },

  async revoke(token: string): Promise<void> {
    const inv = await this.get(token);
    if (!inv) return;
    if (!isKvConfigured()) {
      memTokens.delete(token);
      const arr = memIndex.get(inv.eventId) ?? [];
      memIndex.set(inv.eventId, arr.filter((t) => t !== token));
      return;
    }
    try {
      await kv.del(tk(token));
      const arr = (await kv.get<string[]>(ik(inv.eventId))) ?? [];
      await kv.set(ik(inv.eventId), arr.filter((t) => t !== token));
    } catch {}
  },
};


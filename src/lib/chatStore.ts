// src/lib/chatStore.ts
//
// KV-backed persistence for room chat messages so reloads, late joiners,
// and replay viewers all see the conversation. Falls back to an in-memory
// Map per-process when Vercel KV is not configured.
//
// Keys: neo:chat:<eventId> -> ChatMessage[] JSON (newest last, capped at MAX)

import { kv } from '@vercel/kv';
import type { ChatMessage } from '@/types/event';

const PREFIX = 'neo:chat:';
const MAX_MESSAGES = 500; // hard cap per event to keep payloads small
const MAX_TEXT_LEN = 1000;

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  );
}

const memChats = new Map<string, ChatMessage[]>();

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[neo:chatStore] Vercel KV is not configured - chat is kept in-memory only.'
  );
}

function k(eventId: string): string {
  return PREFIX + eventId;
}

function sanitize(msg: ChatMessage): ChatMessage {
  return {
    id: String(msg.id || "").slice(0, 64),
    userId: msg.userId ? String(msg.userId).slice(0, 64) : null,
    name: String(msg.name || "Anonymous").slice(0, 80),
    text: String(msg.text || "").slice(0, MAX_TEXT_LEN),
    ts: msg.ts || new Date().toISOString(),
    role: msg.role ? String(msg.role).slice(0, 32) : undefined,
  };
}

export const chatStore = {
  isConfigured: isKvConfigured,

  async list(eventId: string): Promise<ChatMessage[]> {
    if (!isKvConfigured()) {
      warnOnce();
      return memChats.get(eventId) ?? [];
    }
    try {
      const raw = await kv.get<ChatMessage[]>(k(eventId));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  },

  async append(eventId: string, msg: ChatMessage): Promise<ChatMessage> {
    const clean = sanitize(msg);
    if (!clean.text.trim()) {
      throw new Error("empty message");
    }
    if (!isKvConfigured()) {
      warnOnce();
      const arr = memChats.get(eventId) ?? [];
      arr.push(clean);
      while (arr.length > MAX_MESSAGES) arr.shift();
      memChats.set(eventId, arr);
      return clean;
    }
    try {
      const arr = (await kv.get<ChatMessage[]>(k(eventId))) ?? [];
      arr.push(clean);
      while (arr.length > MAX_MESSAGES) arr.shift();
      await kv.set(k(eventId), arr);
      return clean;
    } catch {
      // best-effort: never block the live chat on KV outage
      return clean;
    }
  },

  async clear(eventId: string): Promise<void> {
    if (!isKvConfigured()) {
      memChats.delete(eventId);
      return;
    }
    try { await kv.del(k(eventId)); } catch {}
  },
};


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
// Raised from 1000 (which clipped pasted scripture / long-form notes
// mid-sentence — reported symptom "the text pasted all text didnt
// show"). 8000 fits an entire chapter of a Bible verse, a code
// snippet, or a full paragraph of notes while staying well under
// LiveKit's ~15KB reliable-data-channel payload cap.
const MAX_TEXT_LEN = 8000;

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
  const out: ChatMessage = {
    id: String(msg.id || "").slice(0, 64),
    userId: msg.userId ? String(msg.userId).slice(0, 64) : null,
    name: String(msg.name || "Anonymous").slice(0, 80),
    text: String(msg.text || "").slice(0, MAX_TEXT_LEN),
    ts: msg.ts || new Date().toISOString(),
    role: msg.role ? String(msg.role).slice(0, 32) : undefined,
  };
  // Preserve rich fields that earlier revisions of sanitize silently
  // dropped. Persisting them means a viewer who reloads mid-meeting
  // still sees reply context, DM scope, and attachments — which was
  // the whole point of KV persistence in the first place.
  if (msg.replyTo && typeof msg.replyTo === 'object') {
    out.replyTo = {
      id: String(msg.replyTo.id || '').slice(0, 64),
      name: String(msg.replyTo.name || '').slice(0, 80),
      snippet: String(msg.replyTo.snippet || '').slice(0, 140),
    };
  }
  if (Array.isArray(msg.mentions)) {
    out.mentions = msg.mentions
      .map((x) => String(x || '').toLowerCase().slice(0, 80))
      .filter((x) => x.length > 0)
      .slice(0, 25);
  }
  if (typeof msg.toUserId === 'string' && msg.toUserId.trim()) {
    out.toUserId = msg.toUserId.slice(0, 80);
  }
  if (Array.isArray(msg.attachments)) {
    // Bound the array + individually clean each attachment so a
    // malformed client can't stash arbitrary blobs in a persisted
    // ChatMessage. The URL/kind/mime/size are the ONLY fields the
    // renderer trusts — everything else is cosmetic.
    out.attachments = msg.attachments
      .slice(0, 8)
      .map((a) => ({
        url: String(a?.url || '').slice(0, 2048),
        name: String(a?.name || 'file').slice(0, 200),
        mimeType: String(a?.mimeType || 'application/octet-stream').slice(0, 120),
        size: Number.isFinite(a?.size) ? Math.max(0, Math.floor(a.size)) : 0,
        kind: a?.kind === 'image' ? ('image' as const) : ('file' as const),
        ...(Number.isFinite(a?.width) ? { width: Math.floor(a.width!) } : {}),
        ...(Number.isFinite(a?.height) ? { height: Math.floor(a.height!) } : {}),
      }))
      .filter((a) => a.url.startsWith('http'));
  }
  return out;
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
    // Empty text is allowed IF the message carries attachments —
    // "here's a screenshot" with no accompanying words is a
    // legitimate message. Reject only when both are empty.
    if (!clean.text.trim() && (!clean.attachments || clean.attachments.length === 0)) {
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


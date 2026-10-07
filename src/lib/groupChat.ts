// src/lib/groupChat.ts
//
// A group's own chat, apart from any meeting's.
//
// Storage (Vercel KV, in-memory fallback as elsewhere)
//   neo:group:<gid>:msgs            list    newest first, capped at 500
//   neo:group:<gid>:ver             counter bumped on every write
//   neo:group:<gid>:read            hash    userId -> ts (epoch ms) of what they last read
//   neo:group:<gid>:rate:<uid>      counter messages in the current 10 s window
//
// A poll that already has the latest version costs one read: the counter.
// Messages use the meeting chat's shape (ChatMessage) and its length limit,
// plus replies by id, mentions, system lines and attachments kept by R2 key
// (a fresh link is signed each time they are read, so old messages never
// carry dead links).

import { kv } from "@/lib/kv";
import { randomBytes } from "node:crypto";
import { MAX_TEXT_LEN } from "@/lib/chatStore";
import { GroupError, type GroupMember } from "@/lib/groupStore";

export const MAX_GROUP_MESSAGES = 500;
export const PAGE_SIZE = 50;
export const RATE_LIMIT = { messages: 10, windowSeconds: 10 } as const;
export const MAX_ATTACHMENTS = 5;

export interface GroupChatAttachment {
  /** R2 object key; the link is signed when read. */
  key: string;
  name: string;
  size: number;
  mime: string;
  kind: "image" | "file";
}

export interface GroupChatMessage {
  id: string;
  /** Author, or null for a system line. */
  userId: string | null;
  name: string;
  text: string;
  /** ISO time sent. */
  ts: string;
  replyToId?: string;
  /** Who and what is being replied to, captured when sent. */
  replyTo?: { id: string; name: string; snippet: string };
  /** userIds of members mentioned with @Name. */
  mentions?: string[];
  /** A line the app wrote: a meeting scheduled, started, ended or cancelled. */
  system?: true;
  /** For system lines: where it leads (a meeting, its report). */
  link?: { href: string; label: string };
  attachments?: GroupChatAttachment[];
  /** Soft-deleted: text replaced, attachments dropped. */
  deleted?: true;
}

/* -------------------------------------------------------------------------- */
/*  Storage                                                                    */
/* -------------------------------------------------------------------------- */

const msgsKey = (gid: string) => `neo:group:${gid}:msgs`;
const verKey = (gid: string) => `neo:group:${gid}:ver`;
const readKey = (gid: string) => `neo:group:${gid}:read`;
const rateKey = (gid: string, uid: string) => `neo:group:${gid}:rate:${uid}`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const memMsgs = new Map<string, GroupChatMessage[]>();
const memVer = new Map<string, number>();
const memRead = new Map<string, Map<string, number>>();
const memRate = new Map<string, { windowStart: number; count: number }>();

/** Tests only: how many KV-equivalent reads a poll made. */
export const __reads = { count: 0 };

function parse(raw: unknown): GroupChatMessage | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const r = o as GroupChatMessage;
  return typeof r.id === "string" && typeof r.ts === "string" ? r : null;
}

async function readAll(gid: string): Promise<GroupChatMessage[]> {
  __reads.count++;
  if (!isKvConfigured()) return (memMsgs.get(gid) ?? []).slice();
  const raw = (await kv.lrange(msgsKey(gid), 0, MAX_GROUP_MESSAGES - 1)) as unknown[];
  return raw.map(parse).filter((m): m is GroupChatMessage => m !== null);
}

/** The current version: changes whenever anything in the chat does. */
export async function chatVersion(gid: string): Promise<number> {
  __reads.count++;
  if (!isKvConfigured()) return memVer.get(gid) ?? 0;
  const v = await kv.get<number>(verKey(gid));
  return typeof v === "number" ? v : Number(v) || 0;
}

async function bump(gid: string): Promise<number> {
  if (!isKvConfigured()) {
    const v = (memVer.get(gid) ?? 0) + 1;
    memVer.set(gid, v);
    return v;
  }
  return kv.incr(verKey(gid));
}

async function push(gid: string, m: GroupChatMessage): Promise<void> {
  if (!isKvConfigured()) {
    memMsgs.set(gid, [m, ...(memMsgs.get(gid) ?? [])].slice(0, MAX_GROUP_MESSAGES));
  } else {
    await kv.lpush(msgsKey(gid), JSON.stringify(m));
    await kv.ltrim(msgsKey(gid), 0, MAX_GROUP_MESSAGES - 1);
  }
  await bump(gid);
}

/** Forget a group's chat entirely (when the group is deleted). */
export async function deleteGroupChat(gid: string): Promise<void> {
  if (!isKvConfigured()) {
    memMsgs.delete(gid);
    memVer.delete(gid);
    memRead.delete(gid);
    return;
  }
  await kv.del(msgsKey(gid), verKey(gid), readKey(gid));
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface ChatPage {
  ver: number;
  /** Oldest first, for display. */
  messages: GroupChatMessage[];
  /** More, older messages exist before the first one here. */
  hasOlder: boolean;
}

/**
 * A page of messages. Without `before`, the latest 50; with it, the 50 sent
 * before that message. With `sinceVer` equal to the current version, only
 * that is answered — one read.
 */
export async function readChat(
  gid: string,
  opts: { sinceVer?: number; before?: string } = {}
): Promise<ChatPage | { unchanged: true; ver: number }> {
  const ver = await chatVersion(gid);
  if (opts.sinceVer !== undefined && opts.sinceVer === ver && !opts.before) return { unchanged: true, ver };
  const all = await readAll(gid); // newest first
  let start = 0;
  if (opts.before) {
    const i = all.findIndex((m) => m.id === opts.before);
    start = i < 0 ? all.length : i + 1;
  }
  const slice = all.slice(start, start + PAGE_SIZE);
  return { ver, messages: slice.reverse(), hasOlder: start + PAGE_SIZE < all.length };
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                    */
/* -------------------------------------------------------------------------- */

function newId(): string {
  return randomBytes(9).toString("base64url");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The members a message mentions with @Name — only people in the group now,
 * longest names first so "@Ada Obi" is not read as "@Ada". The author is
 * never their own mention.
 */
export function parseMentions(text: string, members: Pick<GroupMember, "userId" | "name">[], authorId?: string): string[] {
  const found = new Set<string>();
  let rest = text;
  const byLength = [...members].filter((m) => m.name.trim()).sort((a, b) => b.name.length - a.name.length);
  for (const m of byLength) {
    const re = new RegExp(`@${escapeRegex(m.name.trim())}(?![\\p{L}\\p{N}_])`, "giu");
    if (re.test(rest)) {
      if (m.userId !== authorId) found.add(m.userId);
      rest = rest.replace(re, " ");
    }
  }
  return Array.from(found);
}

/**
 * At most 10 messages in 10 seconds a person. True if this one may go.
 */
export async function allowMessage(gid: string, uid: string, now: number = Date.now()): Promise<boolean> {
  if (!isKvConfigured()) {
    const k = `${gid}:${uid}`;
    const w = memRate.get(k);
    if (!w || now - w.windowStart >= RATE_LIMIT.windowSeconds * 1000) {
      memRate.set(k, { windowStart: now, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= RATE_LIMIT.messages;
  }
  const count = await kv.incr(rateKey(gid, uid));
  if (count === 1) await kv.expire(rateKey(gid, uid), RATE_LIMIT.windowSeconds);
  return count <= RATE_LIMIT.messages;
}

export interface NewMessage {
  text: unknown;
  replyToId?: unknown;
  attachments?: unknown;
}

function cleanAttachments(raw: unknown, gid: string): GroupChatAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) throw new GroupError("invalid_attachments");
  return raw.map((a) => {
    const r = a as Record<string, unknown>;
    // Only files uploaded to this group's own folder can be attached.
    if (typeof r.key !== "string" || !r.key.startsWith(`groups/${gid}/`) || r.key.length > 400) {
      throw new GroupError("invalid_attachments");
    }
    return {
      key: r.key,
      name: typeof r.name === "string" ? r.name.slice(0, 100) : "file",
      size: typeof r.size === "number" && r.size >= 0 ? r.size : 0,
      mime: typeof r.mime === "string" ? r.mime.slice(0, 120) : "application/octet-stream",
      kind: r.kind === "image" ? "image" : "file",
    };
  });
}

/** Post a member's message. Mentions are worked out from the text. */
export async function postMessage(
  gid: string,
  author: Pick<GroupMember, "userId" | "name">,
  input: NewMessage,
  members: Pick<GroupMember, "userId" | "name">[],
  now: number = Date.now()
): Promise<GroupChatMessage> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length > MAX_TEXT_LEN) throw new GroupError("message_too_long");
  const attachments = cleanAttachments(input.attachments, gid);
  if (!text && attachments.length === 0) throw new GroupError("empty_message");

  let replyTo: GroupChatMessage["replyTo"];
  let replyToId: string | undefined;
  if (input.replyToId !== undefined && input.replyToId !== null) {
    if (typeof input.replyToId !== "string") throw new GroupError("invalid_reply");
    const original = (await readAll(gid)).find((m) => m.id === input.replyToId);
    if (!original) throw new GroupError("invalid_reply");
    replyToId = original.id;
    replyTo = {
      id: original.id,
      name: original.name,
      snippet: original.deleted ? "Message removed" : (original.text || original.attachments?.[0]?.name || "").slice(0, 140),
    };
  }

  const mentions = parseMentions(text, members, author.userId);
  const m: GroupChatMessage = {
    id: newId(),
    userId: author.userId,
    name: author.name.slice(0, 80),
    text,
    ts: new Date(now).toISOString(),
    ...(replyToId ? { replyToId, replyTo } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
  await push(gid, m);
  return m;
}

/** A line the app writes into a group's chat. */
export async function postSystemMessage(
  gid: string,
  text: string,
  link?: { href: string; label: string },
  now: number = Date.now()
): Promise<GroupChatMessage> {
  const m: GroupChatMessage = {
    id: newId(),
    userId: null,
    name: "NeoConference",
    text: text.slice(0, MAX_TEXT_LEN),
    ts: new Date(now).toISOString(),
    system: true,
    ...(link ? { link } : {}),
  };
  await push(gid, m);
  return m;
}

/**
 * Remove a message: its author may, and so may a Moderator or above. It stays
 * in place as "Message removed" so replies to it still make sense.
 */
export async function deleteMessage(
  gid: string,
  mid: string,
  by: { userId: string; canModerate: boolean }
): Promise<GroupChatMessage> {
  const all = await readAll(gid);
  const index = all.findIndex((m) => m.id === mid);
  if (index < 0) throw new GroupError("message_not_found", 404);
  const m = all[index];
  if (m.deleted) return m;
  if (m.system && !by.canModerate) throw new GroupError("insufficient_rank", 403);
  if (m.userId !== by.userId && !by.canModerate) throw new GroupError("insufficient_rank", 403);

  const removed: GroupChatMessage = {
    id: m.id,
    userId: m.userId,
    name: m.name,
    text: "Message removed",
    ts: m.ts,
    deleted: true,
    ...(m.system ? { system: true as const } : {}),
  };
  if (!isKvConfigured()) {
    const list = memMsgs.get(gid) ?? [];
    list[index] = removed;
  } else {
    // A message posted meanwhile shifts the list by one; find it again.
    const current = (await kv.lrange(msgsKey(gid), 0, MAX_GROUP_MESSAGES - 1)) as unknown[];
    const at = current.findIndex((r) => parse(r)?.id === mid);
    if (at < 0) throw new GroupError("message_not_found", 404);
    await kv.lset(msgsKey(gid), at, JSON.stringify(removed));
  }
  await bump(gid);
  return removed;
}

/* -------------------------------------------------------------------------- */
/*  Read markers                                                               */
/* -------------------------------------------------------------------------- */

/** Everything up to `ts` (epoch ms) has been read by this person. */
export async function markChatRead(gid: string, uid: string, ts: number = Date.now()): Promise<void> {
  if (!isKvConfigured()) {
    let b = memRead.get(gid);
    if (!b) {
      b = new Map();
      memRead.set(gid, b);
    }
    b.set(uid, Math.max(b.get(uid) ?? 0, ts));
    return;
  }
  const prev = Number(await kv.hget(readKey(gid), uid)) || 0;
  if (ts > prev) await kv.hset(readKey(gid), { [uid]: ts });
}

/** Messages from others since this person last read the chat. */
export async function unreadChatCount(gid: string, uid: string): Promise<number> {
  const last = !isKvConfigured()
    ? memRead.get(gid)?.get(uid) ?? 0
    : Number(await kv.hget(readKey(gid), uid)) || 0;
  const all = await readAll(gid);
  let n = 0;
  for (const m of all) {
    if (Date.parse(m.ts) <= last) break;
    if (m.userId !== uid && !m.deleted) n++;
  }
  return n;
}

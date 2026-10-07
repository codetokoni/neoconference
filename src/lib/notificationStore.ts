// src/lib/notificationStore.ts
//
// The in-app notification centre: the bell in the header.
//
// Storage (Vercel KV, in-memory fallback as elsewhere)
//   neo:notif:<uid>          list     newest first, capped at 100
//   neo:notif:<uid>:unread   counter  how many in the list are unread
//
// The counter is recounted from the list after every write, so it cannot
// drift when old notifications fall off the end of the list.

import { kv } from "@/lib/kv";
import { randomBytes } from "node:crypto";
import type { PushType } from "@/lib/pushStore";

export const MAX_NOTIFICATIONS = 100;
const PAGE = 20;

export interface AppNotification {
  id: string;
  /** Epoch ms. */
  ts: number;
  type: PushType;
  title: string;
  body: string;
  /** Same-origin path it opens. */
  url: string;
  read: boolean;
  /** Rings: enough for the call overlay to answer or decline it later. */
  eventSlug?: string;
  ringId?: string;
  /** Epoch ms after which the ring is over. */
  expiresAt?: number;
  caller?: string;
  groupName?: string;
  meetingTitle?: string;
}

/** The optional ring fields a notification may carry. */
export type RingFields = Pick<AppNotification, "eventSlug" | "ringId" | "expiresAt" | "caller" | "groupName" | "meetingTitle">;

function ringFields(r: Record<string, unknown>): RingFields {
  const out: RingFields = {};
  if (typeof r.eventSlug === "string") out.eventSlug = r.eventSlug.slice(0, 80);
  if (typeof r.ringId === "string") out.ringId = r.ringId.slice(0, 40);
  if (typeof r.expiresAt === "number") out.expiresAt = r.expiresAt;
  if (typeof r.caller === "string") out.caller = r.caller.slice(0, 120);
  if (typeof r.groupName === "string") out.groupName = r.groupName.slice(0, 120);
  if (typeof r.meetingTitle === "string") out.meetingTitle = r.meetingTitle.slice(0, 200);
  return out;
}

const listKey = (uid: string) => `neo:notif:${uid}`;
const unreadKey = (uid: string) => `neo:notif:${uid}:unread`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const mem = new Map<string, AppNotification[]>();

function parse(raw: unknown): AppNotification | null {
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
  if (typeof r.id !== "string" || typeof r.ts !== "number" || typeof r.type !== "string") return null;
  return {
    id: r.id,
    ts: r.ts,
    type: r.type as PushType,
    title: typeof r.title === "string" ? r.title : "",
    body: typeof r.body === "string" ? r.body : "",
    url: typeof r.url === "string" && r.url.startsWith("/") ? r.url : "/dashboard",
    read: r.read === true,
    ...ringFields(r),
  };
}

async function readAll(uid: string): Promise<AppNotification[]> {
  if (!isKvConfigured()) return (mem.get(uid) ?? []).slice();
  const raw = (await kv.lrange(listKey(uid), 0, MAX_NOTIFICATIONS - 1)) as unknown[];
  return raw.map(parse).filter((n): n is AppNotification => n !== null);
}

async function recount(uid: string, list?: AppNotification[]): Promise<number> {
  const all = list ?? (await readAll(uid));
  const unread = all.filter((n) => !n.read).length;
  if (isKvConfigured()) await kv.set(unreadKey(uid), unread);
  return unread;
}

/** Only same-origin paths are kept, so a notification never sends anyone off-site. */
function safeUrl(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") ? url.slice(0, 500) : "/dashboard";
}

/** Add one to the top of someone's list. */
export async function addNotification(
  uid: string,
  n: { type: PushType; title: string; body: string; url: string } & RingFields,
  now: number = Date.now()
): Promise<AppNotification> {
  const item: AppNotification = {
    id: randomBytes(9).toString("base64url"),
    ts: now,
    type: n.type,
    title: n.title.slice(0, 200),
    body: n.body.slice(0, 500),
    url: safeUrl(n.url),
    read: false,
    ...ringFields(n as unknown as Record<string, unknown>),
  };
  if (!isKvConfigured()) {
    const list = [item, ...(mem.get(uid) ?? [])].slice(0, MAX_NOTIFICATIONS);
    mem.set(uid, list);
    return item;
  }
  await kv.lpush(listKey(uid), JSON.stringify(item));
  await kv.ltrim(listKey(uid), 0, MAX_NOTIFICATIONS - 1);
  await recount(uid);
  return item;
}

/** A page of someone's notifications, newest first. `cursor` is an offset. */
export async function listNotifications(
  uid: string,
  cursor = 0
): Promise<{ items: AppNotification[]; unread: number; nextCursor: number | null }> {
  const all = await readAll(uid);
  const start = Math.max(0, Math.min(cursor, all.length));
  const items = all.slice(start, start + PAGE);
  return {
    items,
    unread: all.filter((n) => !n.read).length,
    nextCursor: start + PAGE < all.length ? start + PAGE : null,
  };
}

/** How many are unread, without reading the list. */
export async function unreadCount(uid: string): Promise<number> {
  if (!isKvConfigured()) return (mem.get(uid) ?? []).filter((n) => !n.read).length;
  const v = await kv.get<number>(unreadKey(uid));
  return typeof v === "number" ? v : recount(uid);
}

/** Mark some (by id) or all as read; returns the unread count after. */
export async function markRead(uid: string, which: { ids: string[] } | { all: true }): Promise<number> {
  const wanted = "ids" in which ? new Set(which.ids) : null;
  const all = await readAll(uid);
  const touch = (n: AppNotification) => !n.read && (wanted === null || wanted.has(n.id));
  if (!all.some(touch)) return all.filter((n) => !n.read).length;

  if (!isKvConfigured()) {
    const next = all.map((n) => (touch(n) ? { ...n, read: true } : n));
    mem.set(uid, next);
    return next.filter((n) => !n.read).length;
  }
  // Each item is updated in place. A notification arriving meanwhile is
  // pushed onto the head and shifts every index by one, so each position is
  // confirmed by id before writing, and looked up afresh if it moved.
  let shift = 0;
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    if (!touch(n)) continue;
    let index = i + shift;
    if (parse(await kv.lindex(listKey(uid), index))?.id !== n.id) {
      const current = (await kv.lrange(listKey(uid), 0, MAX_NOTIFICATIONS - 1)) as unknown[];
      index = current.findIndex((r) => parse(r)?.id === n.id);
      if (index < 0) continue;
      shift = index - i;
    }
    await kv.lset(listKey(uid), index, JSON.stringify({ ...n, read: true }));
  }
  return recount(uid);
}

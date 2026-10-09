// src/lib/pushStore.ts
//
// Web Push: each person's browsers that agreed to call alerts, and sending to
// them.
//
// Storage (Vercel KV, in-memory fallback as elsewhere)
//   neo:push:<uid>   hash   sha256(endpoint) -> { subscription, userAgent, createdAt, lastOkAt }
//
// At most 10 browsers a person; the oldest is dropped when an 11th signs up.
// A push service answering 404 or 410 means that browser unsubscribed or was
// reset, so its subscription is deleted on the spot.
//
// Push is optional: without NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and
// VAPID_SUBJECT it is simply unavailable and every send reports that.

import { createHash } from "node:crypto";
import { kv } from "@/lib/kv";
import webpush from "web-push";
import { isFcmConfigured, sendFcm } from "@/lib/fcmStore";

export const MAX_DEVICES = 10;

export type PushType =
  | "invite"
  | "updated"
  | "cancelled"
  | "started"
  | "added"
  | "reminder"
  | "ring"
  | "missed"
  | "mention"
  /** An administrator's announcement or service notice (src/lib/comms/sends.ts). */
  | "announcement";

/** What the service worker receives (public/sw.js). */
export interface PushPayload {
  type: PushType;
  title: string;
  body: string;
  /** Same-origin path the notification opens. */
  url: string;
  eventSlug?: string;
  groupId?: string;
  ringId?: string;
  /** Epoch ms after which the worker drops it unshown. */
  expiresAt?: number;
  /** Rings: who is calling, from which group, into which meeting. */
  caller?: string;
  groupName?: string;
  meetingTitle?: string;
}

/** A browser's PushSubscription, as PushSubscription.toJSON() gives it. */
export interface BrowserSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface DeviceRecord {
  subscription: BrowserSubscription;
  userAgent: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last push the service accepted; 0 if none yet. */
  lastOkAt: number;
}

export type DeviceOutcome = "sent" | "gone" | "failed";

export interface SendResult {
  configured: boolean;
  devices: Array<{ id: string; outcome: DeviceOutcome; status?: number }>;
}

export interface SendOptions {
  /** Seconds the push service may hold it for an offline browser. */
  ttlSec?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Replaces an undelivered push with the same topic (max 32 URL-safe chars). */
  topic?: string;
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

export function isPushConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT
  );
}

/** The one call that reaches a push service; replaceable in tests. */
export type PushSender = (
  subscription: BrowserSubscription,
  body: string,
  options: { TTL: number; urgency: NonNullable<SendOptions["urgency"]>; topic?: string }
) => Promise<{ statusCode: number }>;

let vapidSet = false;
const defaultSender: PushSender = async (subscription, body, options) => {
  if (!vapidSet) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT!,
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!
    );
    vapidSet = true;
  }
  const res = await webpush.sendNotification(subscription, body, options);
  return { statusCode: res.statusCode };
};
let sender: PushSender = defaultSender;

/** Tests only: route sends through `fake` (or back to web-push with null). */
export function __setPushSender(fake: PushSender | null): void {
  sender = fake ?? defaultSender;
}

/* -------------------------------------------------------------------------- */
/*  Storage                                                                    */
/* -------------------------------------------------------------------------- */

const key = (uid: string) => `neo:push:${uid}`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const mem = new Map<string, Map<string, DeviceRecord>>();

/** A device's id: the hash of its endpoint, so the endpoint itself is never a key. */
export function deviceId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

/** A subscription as the browser sent it, or null when it is not one. */
export function cleanSubscription(raw: unknown): BrowserSubscription | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const endpoint = r.endpoint;
  const keys = r.keys as Record<string, unknown> | undefined;
  if (typeof endpoint !== "string" || endpoint.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  if (keys.p256dh.length > 200 || keys.auth.length > 100) return null;
  return {
    endpoint,
    expirationTime: typeof r.expirationTime === "number" ? r.expirationTime : null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

function parseRecord(raw: unknown): DeviceRecord | null {
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
  const subscription = cleanSubscription(r.subscription);
  if (!subscription) return null;
  return {
    subscription,
    userAgent: typeof r.userAgent === "string" ? r.userAgent : "",
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    lastOkAt: typeof r.lastOkAt === "number" ? r.lastOkAt : 0,
  };
}

export async function listDevices(uid: string): Promise<Map<string, DeviceRecord>> {
  if (!isKvConfigured()) return new Map(mem.get(uid) ?? []);
  const raw = (await kv.hgetall(key(uid))) as Record<string, unknown> | null;
  const out = new Map<string, DeviceRecord>();
  for (const [id, v] of Object.entries(raw ?? {})) {
    const rec = parseRecord(v);
    if (rec) out.set(id, rec);
  }
  return out;
}

async function writeDevice(uid: string, id: string, rec: DeviceRecord): Promise<void> {
  if (!isKvConfigured()) {
    let b = mem.get(uid);
    if (!b) {
      b = new Map();
      mem.set(uid, b);
    }
    b.set(id, rec);
    return;
  }
  await kv.hset(key(uid), { [id]: JSON.stringify(rec) });
}

async function deleteDevices(uid: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!isKvConfigured()) {
    for (const id of ids) mem.get(uid)?.delete(id);
    return;
  }
  await kv.hdel(key(uid), ...ids);
}

/**
 * Remember a browser. The same endpoint signing up again replaces its own
 * entry (keeping when it first signed up); an 11th browser pushes out the
 * one that signed up longest ago.
 */
export async function saveSubscription(
  uid: string,
  subscription: BrowserSubscription,
  userAgent: string,
  now: number = Date.now()
): Promise<{ id: string; evicted: string[] }> {
  const id = deviceId(subscription.endpoint);
  const devices = await listDevices(uid);
  const existing = devices.get(id);
  const rec: DeviceRecord = {
    subscription,
    userAgent: userAgent.slice(0, 300),
    createdAt: existing?.createdAt ?? now,
    lastOkAt: existing?.lastOkAt ?? 0,
  };
  await writeDevice(uid, id, rec);
  devices.set(id, rec);

  const evicted: string[] = [];
  if (devices.size > MAX_DEVICES) {
    const oldestFirst = Array.from(devices.entries())
      .filter(([other]) => other !== id)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [other] of oldestFirst.slice(0, devices.size - MAX_DEVICES)) evicted.push(other);
    await deleteDevices(uid, evicted);
  }
  return { id, evicted };
}

/** Forget one browser by its endpoint. */
export async function removeSubscription(uid: string, endpoint: string): Promise<boolean> {
  const id = deviceId(endpoint);
  const had = (await listDevices(uid)).has(id);
  await deleteDevices(uid, [id]);
  return had;
}

/* -------------------------------------------------------------------------- */
/*  Sending                                                                    */
/* -------------------------------------------------------------------------- */

/** A push topic from any string: URL-safe and at most 32 characters. */
export function topicFor(s: string): string {
  return createHash("sha256").update(s).digest("base64url").slice(0, 32);
}

/**
 * Send to every device a person has: their browsers (Web Push) and their
 * phones running the app (FCM, src/lib/fcmStore.ts). Configured when either
 * is; the devices are both lists, so "has a device" counts phones too.
 */
export async function sendPush(uid: string, payload: PushPayload, opts: SendOptions = {}): Promise<SendResult> {
  const [web, phones] = await Promise.all([
    sendWebPush(uid, payload, opts),
    sendFcm(uid, payload, opts).catch((err) => {
      console.warn("[push] fcm failed", (err as Error).message);
      return { configured: isFcmConfigured(), devices: [] };
    }),
  ]);
  return { configured: web.configured || phones.configured, devices: [...web.devices, ...phones.devices] };
}

/**
 * Send to every browser a person has. Subscriptions the push service says are
 * gone (404, 410) are deleted; the rest record when they last worked.
 */
async function sendWebPush(uid: string, payload: PushPayload, opts: SendOptions): Promise<SendResult> {
  if (!isPushConfigured()) return { configured: false, devices: [] };
  const devices = await listDevices(uid);
  if (devices.size === 0) return { configured: true, devices: [] };

  const body = JSON.stringify(payload);
  const gone: string[] = [];
  const results = await Promise.all(
    Array.from(devices.entries()).map(async ([id, rec]) => {
      try {
        const res = await sender(rec.subscription, body, {
          TTL: opts.ttlSec ?? 60 * 60,
          urgency: opts.urgency ?? "normal",
          ...(opts.topic ? { topic: opts.topic } : {}),
        });
        await writeDevice(uid, id, { ...rec, lastOkAt: Date.now() });
        return { id, outcome: "sent" as const, status: res.statusCode };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          gone.push(id);
          return { id, outcome: "gone" as const, status };
        }
        console.warn("[push] send failed", status ?? "", (err as Error).message);
        return { id, outcome: "failed" as const, ...(status ? { status } : {}) };
      }
    })
  );
  await deleteDevices(uid, gone);
  return { configured: true, devices: results };
}

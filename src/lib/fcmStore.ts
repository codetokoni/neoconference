// src/lib/fcmStore.ts
//
// Firebase Cloud Messaging: the phone app's devices, and sending to them.
// The web's call alerts are Web Push (src/lib/pushStore.ts); the Android app
// cannot receive those, so it registers an FCM token instead and sendPush
// fans every push out to both.
//
// Storage (Vercel KV, in-memory fallback as elsewhere)
//   neo:fcm:<uid>   hash   sha256(token) -> { token, platform, createdAt, lastOkAt }
//
// At most 10 devices a person; the oldest is dropped when an 11th signs up.
// FCM answering UNREGISTERED (or 404, or an invalid token) means the app was
// uninstalled or its token rotated, so that device is deleted on the spot.
//
// Messages are data-only: the app builds the notification itself, which is
// what lets a ring open the full-screen incoming-call screen.
//
// Optional: without FIREBASE_SERVICE_ACCOUNT (the service account's JSON key)
// it is simply unavailable and sends report that.

import { createHash } from "node:crypto";
import { kv } from "@vercel/kv";
import { SignJWT, importPKCS8 } from "jose";
import type { PushPayload, SendOptions } from "@/lib/pushStore";

export const MAX_FCM_DEVICES = 10;

export interface FcmDevice {
  token: string;
  platform: "android";
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last message FCM accepted; 0 if none yet. */
  lastOkAt: number;
}

export type FcmOutcome = "sent" | "gone" | "failed";

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

let parsedFrom: string | undefined;
let parsed: ServiceAccount | null = null;

/** The service account from FIREBASE_SERVICE_ACCOUNT, or null. */
function serviceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw === parsedFrom) return parsed;
  parsedFrom = raw;
  parsed = null;
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const projectId = j.project_id;
    const clientEmail = j.client_email;
    const privateKey = j.private_key;
    if (typeof projectId === "string" && typeof clientEmail === "string" && typeof privateKey === "string") {
      // Pasted into a dashboard, the key's line breaks can arrive as "\n".
      parsed = { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") };
    } else {
      console.warn("[fcm] FIREBASE_SERVICE_ACCOUNT lacks project_id, client_email or private_key");
    }
  } catch {
    console.warn("[fcm] FIREBASE_SERVICE_ACCOUNT is not JSON");
  }
  return parsed;
}

export function isFcmConfigured(): boolean {
  return serviceAccount() !== null;
}

/* -------------------------------------------------------------------------- */
/*  Access token                                                               */
/* -------------------------------------------------------------------------- */

let cachedToken: { value: string; expiresAt: number } | null = null;

/** An OAuth access token for FCM, from the service account; reused until a minute before it lapses. */
async function accessToken(sa: ServiceAccount, now: number = Date.now()): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;
  const key = await importPKCS8(sa.privateKey, "RS256");
  const iat = Math.floor(now / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.clientEmail)
    .setSubject(sa.clientEmail)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("token exchange returned no access_token");
  cachedToken = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

/* -------------------------------------------------------------------------- */
/*  Sending, replaceable in tests                                              */
/* -------------------------------------------------------------------------- */

/** FCM's answer to one message: its HTTP status and, on failure, its error code. */
export type FcmSender = (
  token: string,
  data: Record<string, string>,
  android: { priority: "HIGH" | "NORMAL"; ttl: string; collapse_key?: string }
) => Promise<{ status: number; errorCode?: string }>;

const defaultSender: FcmSender = async (token, data, android) => {
  const sa = serviceAccount();
  if (!sa) return { status: 503, errorCode: "NOT_CONFIGURED" };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.projectId)}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(sa)}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { token, data, android } }),
  });
  if (res.ok) return { status: res.status };
  const err = (await res.json().catch(() => ({}))) as {
    error?: { status?: string; details?: Array<{ errorCode?: string }> };
  };
  const errorCode = err.error?.details?.find((d) => d.errorCode)?.errorCode ?? err.error?.status;
  return { status: res.status, ...(errorCode ? { errorCode } : {}) };
};
let sender: FcmSender = defaultSender;

/** Tests only: route sends through `fake` (or back to FCM with null). */
export function __setFcmSender(fake: FcmSender | null): void {
  sender = fake ?? defaultSender;
}

/* -------------------------------------------------------------------------- */
/*  Storage                                                                    */
/* -------------------------------------------------------------------------- */

const key = (uid: string) => `neo:fcm:${uid}`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const mem = new Map<string, Map<string, FcmDevice>>();

/** A device's id: the hash of its token, so the token itself is never a key. */
export function fcmDeviceId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** An FCM registration token as the app sent it, or null. */
export function cleanFcmToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length >= 20 && t.length <= 4096 && /^[\w:.\-]+$/.test(t) ? t : null;
}

function parseDevice(raw: unknown): FcmDevice | null {
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
  const token = cleanFcmToken(r.token);
  if (!token) return null;
  return {
    token,
    platform: "android",
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    lastOkAt: typeof r.lastOkAt === "number" ? r.lastOkAt : 0,
  };
}

export async function listFcmDevices(uid: string): Promise<Map<string, FcmDevice>> {
  if (!isKvConfigured()) return new Map(mem.get(uid) ?? []);
  const raw = (await kv.hgetall(key(uid))) as Record<string, unknown> | null;
  const out = new Map<string, FcmDevice>();
  for (const [id, v] of Object.entries(raw ?? {})) {
    const rec = parseDevice(v);
    if (rec) out.set(id, rec);
  }
  return out;
}

async function writeDevice(uid: string, id: string, rec: FcmDevice): Promise<void> {
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
 * Remember a phone. The same token again replaces its own entry; an 11th
 * device pushes out the one that signed up longest ago.
 */
export async function saveFcmToken(
  uid: string,
  token: string,
  now: number = Date.now()
): Promise<{ id: string; evicted: string[] }> {
  const id = fcmDeviceId(token);
  const devices = await listFcmDevices(uid);
  const existing = devices.get(id);
  const rec: FcmDevice = {
    token,
    platform: "android",
    createdAt: existing?.createdAt ?? now,
    lastOkAt: existing?.lastOkAt ?? 0,
  };
  await writeDevice(uid, id, rec);
  devices.set(id, rec);

  const evicted: string[] = [];
  if (devices.size > MAX_FCM_DEVICES) {
    const oldestFirst = Array.from(devices.entries())
      .filter(([other]) => other !== id)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [other] of oldestFirst.slice(0, devices.size - MAX_FCM_DEVICES)) evicted.push(other);
    await deleteDevices(uid, evicted);
  }
  return { id, evicted };
}

/** Forget one phone (signing out of the app). */
export async function removeFcmToken(uid: string, token: string): Promise<boolean> {
  const id = fcmDeviceId(token);
  const had = (await listFcmDevices(uid)).has(id);
  await deleteDevices(uid, [id]);
  return had;
}

/* -------------------------------------------------------------------------- */
/*  Sending                                                                    */
/* -------------------------------------------------------------------------- */

/** FCM data values must all be strings. */
export function fcmData(payload: PushPayload): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * FCM refusals that mean the token will never work again. Not
 * INVALID_ARGUMENT: FCM also says that about a malformed message, and a bad
 * message must not cost every phone its registration.
 */
const GONE = new Set(["UNREGISTERED", "NOT_FOUND"]);

/**
 * Send to every phone a person has. Tokens FCM says are dead are deleted; the
 * rest record when they last worked.
 */
export async function sendFcm(
  uid: string,
  payload: PushPayload,
  opts: SendOptions = {}
): Promise<{ configured: boolean; devices: Array<{ id: string; outcome: FcmOutcome; status?: number }> }> {
  if (!isFcmConfigured()) return { configured: false, devices: [] };
  const devices = await listFcmDevices(uid);
  if (devices.size === 0) return { configured: true, devices: [] };

  const data = fcmData(payload);
  const android = {
    priority: opts.urgency === "high" ? ("HIGH" as const) : ("NORMAL" as const),
    ttl: `${Math.max(0, Math.round(opts.ttlSec ?? 60 * 60))}s`,
    ...(opts.topic ? { collapse_key: opts.topic } : {}),
  };
  const gone: string[] = [];
  const results = await Promise.all(
    Array.from(devices.entries()).map(async ([id, rec]) => {
      try {
        const res = await sender(rec.token, data, android);
        if (res.status >= 200 && res.status < 300) {
          await writeDevice(uid, id, { ...rec, lastOkAt: Date.now() });
          return { id: `fcm:${id}`, outcome: "sent" as const, status: res.status };
        }
        if (res.status === 404 || (res.errorCode && GONE.has(res.errorCode))) {
          gone.push(id);
          return { id: `fcm:${id}`, outcome: "gone" as const, status: res.status };
        }
        console.warn("[fcm] send failed", res.status, res.errorCode ?? "");
        return { id: `fcm:${id}`, outcome: "failed" as const, status: res.status };
      } catch (err) {
        console.warn("[fcm] send failed", (err as Error).message);
        return { id: `fcm:${id}`, outcome: "failed" as const };
      }
    })
  );
  await deleteDevices(uid, gone);
  return { configured: true, devices: results };
}

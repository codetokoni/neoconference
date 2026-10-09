// src/lib/platform/webhooks.ts
//
// Platform webhooks: URLs the platform POSTs to when something happens on
// it, signed so the receiver can tell the call is genuine.
//
//   neo:webhooks:endpoints   hash id -> WebhookEndpoint JSON (with secrets)
//   neo:webhooks:log         list of deliveries, newest first, last 500
//
// Signature (Stripe-style), on every delivery:
//
//   x-neo-signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]
//   v1 = HMAC-SHA256(secret, "<t>.<raw body>")
//
// Rotating a secret makes a new one (shown once) and keeps the old one
// signing alongside it until the grace period ends, so a receiver can move
// to the new secret without missing a delivery. verifyWebhookSignature()
// is the receiver's side.
//
// Secrets never leave this file except as the one-time value returned when
// they are made; everything else sees a fingerprint.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { kv } from "@/lib/kv";
import { fingerprint } from "@/lib/platform/integrations";

const ENDPOINTS = "neo:webhooks:endpoints";
const LOG = "neo:webhooks:log";
const LOG_KEEP = 500;

export const DEFAULT_GRACE_HOURS = 24;
export const MAX_GRACE_HOURS = 24 * 7;
const TIMEOUT_MS = 5_000;

export const WEBHOOK_EVENTS = [
  { key: "webhook.test", label: "Test delivery (sent from the admin)" },
  { key: "maintenance.started", label: "Maintenance mode turned on" },
  { key: "maintenance.ended", label: "Maintenance mode turned off" },
  { key: "feature.changed", label: "A feature was turned on or off" },
  { key: "settings.changed", label: "Platform settings changed" },
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]["key"];

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === "string" && WEBHOOK_EVENTS.some((e) => e.key === v);
}

interface StoredSecret {
  secret: string;
  createdAt: number;
  /** null = current. A rotated-out secret keeps signing until then. */
  expiresAt: number | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  secrets: StoredSecret[];
}

export interface PublicEndpoint extends Omit<WebhookEndpoint, "secrets"> {
  secrets: { fingerprint: string; createdAt: number; expiresAt: number | null; current: boolean }[];
}

export interface Delivery {
  id: string;
  endpointId: string;
  url: string;
  event: string;
  ts: number;
  ok: boolean;
  status: number | null;
  durationMs: number;
  error?: string;
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

export function newSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

/** Secrets still signing at `now`: the current one and any in their grace period. */
export function liveSecrets(e: WebhookEndpoint, now = Date.now()): StoredSecret[] {
  return e.secrets.filter((s) => s.expiresAt === null || s.expiresAt > now);
}

export function publicEndpoint(e: WebhookEndpoint, now = Date.now()): PublicEndpoint {
  return {
    ...e,
    secrets: liveSecrets(e, now).map((s) => ({
      fingerprint: fingerprint(s.secret),
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      current: s.expiresAt === null,
    })),
  };
}

/** https only, and not an address inside a private network (the server would be calling itself). */
export function webhookUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Enter a full address starting with https://";
  }
  if (u.protocol !== "https:") return "Webhook addresses must use https://";
  if (u.username || u.password) return "Put credentials in the receiver's checks, not in the address.";
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || /\.(localhost|local|internal)$/.test(h)) return "That address is not reachable from the internet.";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      return "Private and loopback addresses are not allowed.";
    }
  }
  if (h.includes(":")) return "Use a host name, not an IPv6 address.";
  return null;
}

export async function listEndpoints(): Promise<WebhookEndpoint[]> {
  const all = ((await kv.hgetall(ENDPOINTS)) ?? {}) as Record<string, unknown>;
  return Object.values(all)
    .map((x) => parse<WebhookEndpoint>(x))
    .filter((x): x is WebhookEndpoint => !!x)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function getEndpoint(id: string): Promise<WebhookEndpoint | null> {
  return parse<WebhookEndpoint>(await kv.hget(ENDPOINTS, id));
}

export async function saveEndpoint(e: WebhookEndpoint): Promise<void> {
  // Secrets past their grace period are dropped for good on the next save.
  const now = Date.now();
  await kv.hset(ENDPOINTS, { [e.id]: JSON.stringify({ ...e, secrets: liveSecrets(e, now), updatedAt: now }) });
}

export async function deleteEndpoint(id: string): Promise<void> {
  await kv.hdel(ENDPOINTS, id);
}

export async function createEndpoint(input: { url: string; description: string; events: WebhookEvent[]; createdBy: string }): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  const now = Date.now();
  const secret = newSecret();
  const endpoint: WebhookEndpoint = {
    id: `wh_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    url: input.url,
    description: input.description,
    events: input.events,
    enabled: true,
    createdAt: now,
    createdBy: input.createdBy,
    updatedAt: now,
    secrets: [{ secret, createdAt: now, expiresAt: null }],
  };
  await saveEndpoint(endpoint);
  return { endpoint, secret };
}

/**
 * A new current secret; the previous current one keeps signing for
 * `graceHours` (0 = retire it now). Returns the new secret — the only time
 * it is ever shown.
 */
export async function rotateSecret(id: string, graceHours: number): Promise<{ endpoint: WebhookEndpoint; secret: string; before: PublicEndpoint } | null> {
  const e = await getEndpoint(id);
  if (!e) return null;
  const now = Date.now();
  const before = publicEndpoint(e, now);
  const hours = Math.max(0, Math.min(MAX_GRACE_HOURS, graceHours));
  const secret = newSecret();
  e.secrets = [
    { secret, createdAt: now, expiresAt: null },
    ...liveSecrets(e, now).map((s) => (s.expiresAt === null ? { ...s, expiresAt: now + hours * 3600_000 } : s)),
  ].filter((s) => s.expiresAt === null || s.expiresAt > now);
  await saveEndpoint(e);
  return { endpoint: e, secret, before };
}

export function sign(secret: string, t: number, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

export function signatureHeader(e: WebhookEndpoint, t: number, body: string, now = Date.now()): string {
  return [`t=${t}`, ...liveSecrets(e, now).map((s) => `v1=${sign(s.secret, t, body)}`)].join(",");
}

/** The receiver's check: does any v1 in the header match this secret (within `toleranceSec`)? */
export function verifyWebhookSignature(header: string, body: string, secret: string, toleranceSec = 300, nowMs = Date.now()): boolean {
  const parts = header.split(",").map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith("t="))?.slice(2));
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const want = Buffer.from(sign(secret, t, body), "hex");
  return parts
    .filter((p) => p.startsWith("v1="))
    .some((p) => {
      const got = Buffer.from(p.slice(3), "hex");
      return got.length === want.length && timingSafeEqual(got, want);
    });
}

async function deliverOne(e: WebhookEndpoint, event: string, data: unknown): Promise<Delivery> {
  const started = Date.now();
  const id = `dlv_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const body = JSON.stringify({ id, type: event, createdAt: new Date(started).toISOString(), data });
  const t = Math.floor(started / 1000);
  const base = { id, endpointId: e.id, url: e.url, event, ts: started };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(e.url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "NeoConference-Webhooks/1", "x-neo-event": event, "x-neo-delivery": id, "x-neo-signature": signatureHeader(e, t, body, started) },
      body,
      signal: ctl.signal,
      redirect: "manual",
    });
    return { ...base, ok: res.ok, status: res.status, durationMs: Date.now() - started };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return { ...base, ok: false, status: null, durationMs: Date.now() - started, error: aborted ? `no answer within ${TIMEOUT_MS / 1000}s` : String((err as Error)?.message ?? err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

async function logDelivery(d: Delivery): Promise<void> {
  try {
    await kv.lpush(LOG, JSON.stringify(d));
    await kv.ltrim(LOG, 0, LOG_KEEP - 1);
  } catch (err) {
    console.error("[webhooks] log write failed", err);
  }
}

/**
 * Send `event` to every enabled endpoint that listens for it, and wait for
 * the answers (each at most TIMEOUT_MS) — on Vercel, work left running after
 * the response may never happen. A failed delivery is logged, never thrown.
 */
export async function emitPlatformEvent(event: WebhookEvent, data: unknown, only?: string): Promise<Delivery[]> {
  let endpoints: WebhookEndpoint[] = [];
  try {
    endpoints = (await listEndpoints()).filter((e) => (only ? e.id === only : e.enabled && e.events.includes(event)));
  } catch (err) {
    console.error("[webhooks] endpoints unreadable", err);
    return [];
  }
  const out = await Promise.all(endpoints.map((e) => deliverOne(e, event, data)));
  for (const d of out) await logDelivery(d);
  return out;
}

export async function listDeliveries(endpointId?: string, limit = 100): Promise<Delivery[]> {
  const raw = ((await kv.lrange(LOG, 0, LOG_KEEP - 1)) ?? []) as unknown[];
  return raw
    .map((r) => parse<Delivery>(r))
    .filter((d): d is Delivery => !!d && (!endpointId || d.endpointId === endpointId))
    .slice(0, limit);
}

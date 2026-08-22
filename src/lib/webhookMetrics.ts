// src/lib/webhookMetrics.ts
//
// Lightweight per-event webhook telemetry. Every event the LiveKit webhook
// route processes bumps a KV counter for its event type and stamps the
// last-seen timestamp so an admin can verify the correct events are actually
// subscribed on the LiveKit Cloud side.
//
// The values are what /api/admin/verify-webhooks surfaces to the runbook —
// after a dashboard change the admin can call the endpoint and immediately
// see whether participant_joined / participant_left are landing or still
// silent (indicating the LiveKit subscription wasn't saved).
//
// Storage: neo:webhook:metrics — one Redis hash. Field names look like
// "count:participant_joined" and "lastAt:participant_joined". Values are
// stringified.

import { kv } from "@vercel/kv";

const KEY = "neo:webhook:metrics";

const KNOWN_EVENTS = [
  "room_started",
  "room_finished",
  "participant_joined",
  "participant_left",
  "egress_started",
  "egress_updated",
  "egress_ended",
] as const;

export type WebhookEventType = (typeof KNOWN_EVENTS)[number];

export interface WebhookMetric {
  event: WebhookEventType;
  count: number;
  lastAtMs: number | null;
}

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// In-memory fallback for tests and unconfigured environments.
const memMetrics = new Map<string, { count: number; lastAtMs: number }>();

/**
 * Bump the counter for one event type. Never throws — telemetry must not be
 * able to break the webhook handler that feeds it.
 */
export async function recordWebhookEvent(event: string): Promise<void> {
  const now = Date.now();
  if (!isKvConfigured()) {
    const prev = memMetrics.get(event) || { count: 0, lastAtMs: 0 };
    memMetrics.set(event, { count: prev.count + 1, lastAtMs: now });
    return;
  }
  try {
    await kv.hincrby(KEY, `count:${event}`, 1);
    await kv.hset(KEY, { [`lastAt:${event}`]: String(now) });
  } catch (err) {
    console.warn("[webhook-metrics] KV write failed", err);
  }
}

/**
 * Read the current counter for every known event type. Absent counters
 * report as count=0 and lastAtMs=null so the response shape is stable.
 */
export async function readWebhookMetrics(): Promise<WebhookMetric[]> {
  const out: WebhookMetric[] = [];
  if (!isKvConfigured()) {
    for (const event of KNOWN_EVENTS) {
      const m = memMetrics.get(event);
      out.push({ event, count: m?.count ?? 0, lastAtMs: m?.lastAtMs ?? null });
    }
    return out;
  }
  try {
    const raw = (await kv.hgetall(KEY)) as Record<string, unknown> | null;
    const map = raw || {};
    for (const event of KNOWN_EVENTS) {
      const rawCount = map[`count:${event}`];
      const rawLast = map[`lastAt:${event}`];
      const count = typeof rawCount === "number"
        ? rawCount
        : typeof rawCount === "string" ? parseInt(rawCount, 10) || 0 : 0;
      const lastAtMs = typeof rawLast === "number"
        ? rawLast
        : typeof rawLast === "string" ? parseInt(rawLast, 10) || null : null;
      out.push({ event, count, lastAtMs });
    }
    return out;
  } catch (err) {
    console.warn("[webhook-metrics] KV read failed", err);
    return KNOWN_EVENTS.map((event) => ({ event, count: 0, lastAtMs: null }));
  }
}

/** Test seam — clears the in-memory fallback. */
export function __resetInMemoryWebhookMetrics(): void {
  memMetrics.clear();
}

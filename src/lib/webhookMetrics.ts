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

// ---------------------------------------------------------------------------
// Rejections
//
// The counters above say an event arrived. They do not say what happened to
// it, and a rejected event bumps the same counter as a handled one — the
// bump happens before the handler runs. That gap is why the stuck meetings
// could only be guessed at afterwards: room_finished had fired 224 times
// and 7 rooms were still open, with nothing recording which 7 or why.
//
// So every room_finished that does not end a meeting is written down, with
// the room name and the reason. Capped at RECENT_LIMIT because this is a
// diagnostic, not an audit log — the interesting ones are the recent ones,
// and an unbounded list in Redis is a slow leak.

const REJECTIONS_KEY = "neo:webhook:rejections";
const RECENT_LIMIT = 50;

export interface WebhookRejection {
  atMs: number;
  event: string;
  /** The LiveKit room name, which is the one thing needed to find the event. */
  room: string;
  /** Machine-readable: no_room | event_not_found | not_in_progress */
  reason: string;
  /** The event's state at the time, where there was an event. */
  state?: string;
  eventId?: string;
}

const memRejections: WebhookRejection[] = [];

/**
 * Write down a webhook that arrived and changed nothing.
 *
 * Never throws, for the same reason the counters do not: diagnostics must
 * not be able to break the handler that feeds them. Also logged to the
 * console so it is greppable in Vercel logs without a KV round trip.
 */
export async function recordWebhookRejection(
  rejection: Omit<WebhookRejection, "atMs">
): Promise<void> {
  const entry: WebhookRejection = { ...rejection, atMs: Date.now() };

  // eslint-disable-next-line no-console
  console.warn(
    "[webhook-rejected]",
    entry.event,
    "room=" + entry.room,
    "reason=" + entry.reason,
    entry.state ? "state=" + entry.state : "",
    entry.eventId ? "eventId=" + entry.eventId : ""
  );

  if (!isKvConfigured()) {
    memRejections.unshift(entry);
    memRejections.length = Math.min(memRejections.length, RECENT_LIMIT);
    return;
  }
  try {
    await kv.lpush(REJECTIONS_KEY, JSON.stringify(entry));
    await kv.ltrim(REJECTIONS_KEY, 0, RECENT_LIMIT - 1);
  } catch (err) {
    console.warn("[webhook-metrics] rejection write failed", err);
  }
}

/** The most recent rejections, newest first. */
export async function readWebhookRejections(
  limit = RECENT_LIMIT
): Promise<WebhookRejection[]> {
  const capped = Math.max(1, Math.min(limit, RECENT_LIMIT));
  if (!isKvConfigured()) return memRejections.slice(0, capped);

  try {
    const raw = await kv.lrange(REJECTIONS_KEY, 0, capped - 1);
    const out: WebhookRejection[] = [];
    for (const item of raw || []) {
      // Upstash may hand back an already-parsed object or the raw string,
      // depending on how it was written and which client version ran.
      if (item && typeof item === "object") {
        out.push(item as WebhookRejection);
        continue;
      }
      if (typeof item === "string") {
        try {
          out.push(JSON.parse(item) as WebhookRejection);
        } catch {
          // A single malformed row should not hide the rest.
        }
      }
    }
    return out;
  } catch (err) {
    console.warn("[webhook-metrics] rejection read failed", err);
    return [];
  }
}

/** Test seam — clears the in-memory fallback. */
export function __resetInMemoryWebhookMetrics(): void {
  memMetrics.clear();
  memRejections.length = 0;
}

/**
 * Test seam — how many rejections are actually being held.
 *
 * Distinct from what readWebhookRejections returns, which caps the result
 * on the way out. A test that only checks the read cannot tell a trimmed
 * store from an unbounded one that is being read 50 at a time, and that
 * was exactly the hole in the first version of these tests.
 */
export function __inMemoryRejectionCount(): number {
  return memRejections.length;
}

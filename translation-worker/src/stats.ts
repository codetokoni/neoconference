/**
 * Per-room DeepL usage + error tracking for the translation worker.
 *
 * Two things producers actually need to see mid-event:
 *
 *   1. "Are we about to run out of DeepL credits?" → running char
 *      count per room, both total-since-start and a rolling 60s
 *      window so a burst of chatter is immediately visible.
 *
 *   2. "Is DeepL currently 429'ing us?" → rolling 60s error count
 *      per room, plus the last error message so you can tell rate
 *      limits (429 Too Many Requests) from quota exhaustion
 *      (456 Quota Exceeded) from auth problems (403).
 *
 * Everything is in-memory — restart the worker and stats reset.
 * Persistence is intentionally not built in because the alert side
 * of this file is what matters during an event; the raw numbers
 * matter after, and by then you have the DeepL account page anyway.
 */

const WINDOW_MS = 60_000;
const ALERT_ERROR_THRESHOLD = Number(process.env.ALERT_ERROR_THRESHOLD ?? "5");
const ALERT_DEBOUNCE_MS = Number(process.env.ALERT_DEBOUNCE_MS ?? "600000"); // 10 min

interface RoomStats {
  room: string;
  startedAt: number;
  // Totals across the whole worker lifetime
  charsTotal: number;
  errorsTotal: number;
  // 60s rolling window
  windowStart: number;
  charsWindow: number;
  errorsWindow: number;
  // Diagnostics
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  // Alert bookkeeping so we don't spam Slack
  lastAlertAt: number;
}

const stats = new Map<string, RoomStats>();

function get(room: string): RoomStats {
  let s = stats.get(room);
  const now = Date.now();
  if (!s) {
    s = {
      room,
      startedAt: now,
      charsTotal: 0,
      errorsTotal: 0,
      windowStart: now,
      charsWindow: 0,
      errorsWindow: 0,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastAlertAt: 0,
    };
    stats.set(room, s);
  }
  if (now - s.windowStart > WINDOW_MS) {
    s.windowStart = now;
    s.charsWindow = 0;
    s.errorsWindow = 0;
  }
  return s;
}

/** Record a successful DeepL call; character count is the source length. */
export function recordDeeplChars(room: string, chars: number): void {
  const s = get(room);
  s.charsTotal += chars;
  s.charsWindow += chars;
}

/**
 * Record a failed DeepL call. Returns true when the caller should
 * fire an alert — the caller (index.ts) actually posts to Slack.
 * Kept as a caller-driven side-effect so this file has no network
 * dependency and stays trivially testable.
 */
export function recordDeeplError(room: string, message: string): boolean {
  const s = get(room);
  const now = Date.now();
  s.errorsTotal += 1;
  s.errorsWindow += 1;
  s.lastErrorAt = now;
  s.lastErrorMessage = message.slice(0, 200);
  if (
    s.errorsWindow >= ALERT_ERROR_THRESHOLD &&
    now - s.lastAlertAt > ALERT_DEBOUNCE_MS
  ) {
    s.lastAlertAt = now;
    return true;
  }
  return false;
}

/** Snapshot of the stats table for the /stats HTTP endpoint. */
export function snapshotStats(): {
  uptimeSec: number;
  rooms: Array<{
    room: string;
    startedAt: number;
    charsTotal: number;
    charsWindow: number;
    errorsTotal: number;
    errorsWindow: number;
    lastErrorAt: number | null;
    lastErrorMessage: string | null;
  }>;
} {
  const rooms = Array.from(stats.values()).map((s) => {
    // Force the window bookkeeping to advance before we read so the
    // snapshot is truthful. Otherwise a room whose last activity was
    // 5 minutes ago still shows a stale non-zero window count.
    get(s.room);
    return {
      room: s.room,
      startedAt: s.startedAt,
      charsTotal: s.charsTotal,
      charsWindow: s.charsWindow,
      errorsTotal: s.errorsTotal,
      errorsWindow: s.errorsWindow,
      lastErrorAt: s.lastErrorAt,
      lastErrorMessage: s.lastErrorMessage,
    };
  });
  return { uptimeSec: Math.round(process.uptime()), rooms };
}

/**
 * Post an alert to Slack (or any incoming-webhook-compatible
 * endpoint — Discord, Mattermost, custom bridge). No-op when
 * SLACK_ALERT_WEBHOOK isn't configured.
 *
 * Body is intentionally minimal — one line, room + count + last
 * message. Operators reading this on their phone don't need JSON.
 */
export async function postAlert(text: string): Promise<void> {
  const url = process.env.SLACK_ALERT_WEBHOOK?.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    // Alerting failure MUST NOT take down the worker — just log.
    console.error("[alert] webhook failed:", (e as Error).message);
  }
}

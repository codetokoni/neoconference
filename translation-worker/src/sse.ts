import http from "node:http";
import cors from "cors";
import { snapshotStats } from "./stats.js";

/**
 * Lightweight SSE broadcaster.
 *
 * One HTTP server per worker. Clients connect to
 *
 *   GET /translations/<room>/<lang>
 *
 * and receive every published line as a `data: <json>\n\n` event. New
 * subscribers immediately receive the last known line so someone who
 * arrives mid-sentence doesn't stare at a blank overlay for a beat.
 *
 * Kept dependency-thin on purpose — Express is overkill for one route.
 */

export interface Line {
  lang: string;
  text: string;
  seq: number;
  ts: number;
  original?: string;
  final?: boolean;
}

type Key = string; // `${room}:${lang}`

const subs = new Map<Key, Set<http.ServerResponse>>();
const last = new Map<Key, Line>();

// Total subscribers per room across all langs — the supervisor uses
// this to decide when to start/stop that room's ffmpeg+Deepgram pipe.
const roomSubCount = new Map<string, number>();

type RoomHook = (room: string) => void;
let onFirstHook: RoomHook | null = null;
let onLastHook: RoomHook | null = null;

/** Fired once when a room's total subscriber count goes 0 → 1. */
export function onFirstSubscriberForRoom(fn: RoomHook): void {
  onFirstHook = fn;
}

/** Fired once when a room's total subscriber count goes 1 → 0. */
export function onLastSubscriberForRoom(fn: RoomHook): void {
  onLastHook = fn;
}

const corsMw = cors({ origin: true, credentials: false });

function subKey(room: string, lang: string): Key {
  return `${room}:${lang}`;
}

/** Broadcast one line to every subscriber of that (room, lang). */
export function broadcast(room: string, line: Line): void {
  const k = subKey(room, line.lang);
  last.set(k, line);
  const set = subs.get(k);
  if (!set) return;
  const chunk = "data: " + JSON.stringify(line) + "\n\n";
  for (const res of set) {
    try {
      res.write(chunk);
    } catch {
      /* subscriber died; onclose cleans it up */
    }
  }
}

/**
 * Per-room ring buffer of finalised source utterances. Lets clients
 * hit /transcript/<room> and get everything said so far, without
 * needing to have been subscribed since the start of the event.
 * TRANSCRIPT_MAX_LINES is set generously — at ~15 words / utterance
 * and one utterance every 3-4s, 2000 lines covers ~2 hours of
 * continuous speaking, which fits typical sessions with headroom.
 */
const TRANSCRIPT_MAX_LINES = Number(process.env.TRANSCRIPT_MAX_LINES ?? "2000");
const transcripts = new Map<string, Line[]>();

export function recordTranscript(room: string, line: Line): void {
  let arr = transcripts.get(room);
  if (!arr) {
    arr = [];
    transcripts.set(room, arr);
  }
  arr.push(line);
  if (arr.length > TRANSCRIPT_MAX_LINES) {
    // Drop the oldest chunk in one shot instead of shifting on every
    // push. shift() would degrade to O(n) per utterance once the
    // buffer is full; splice-drop is a batched O(k).
    arr.splice(0, arr.length - TRANSCRIPT_MAX_LINES);
  }
}

export function getTranscript(room: string): Line[] {
  return transcripts.get(room) ?? [];
}

export function clearTranscript(room: string): void {
  transcripts.delete(room);
}

export function startSseServer(port: number): void {
  const server = http.createServer((req, res) => {
    corsMw(req as unknown as Parameters<typeof corsMw>[0], res as unknown as Parameters<typeof corsMw>[1], () => {
      if (!req.url) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/healthz") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("ok\n");
        return;
      }
      // /stats — per-room DeepL usage + error snapshot. One shot,
      // JSON. Callers include the Next.js /api/video/health strip and
      // any external monitoring (Datadog, Prometheus scraper, etc.)
      // pointed at this worker.
      if (url.pathname === "/stats") {
        const snap = snapshotStats();
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ ok: true, ...snap }));
        return;
      }
      // /transcript/<room> — everything said so far, JSON. One shot,
      // not SSE. Optional ?since=<seq> returns only lines newer than
      // that sequence number so pollers don't re-download the full
      // buffer every tick.
      const tm = url.pathname.match(/^\/transcript\/([^/]+)\/?$/);
      if (tm) {
        const room = decodeURIComponent(tm[1]);
        const since = Number(url.searchParams.get("since") ?? "0");
        const all = getTranscript(room);
        const filtered = Number.isFinite(since) && since > 0
          ? all.filter((l) => l.seq > since)
          : all;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ ok: true, room, count: filtered.length, lines: filtered }));
        return;
      }
      // /translations/<room>/<lang>
      const m = url.pathname.match(/^\/translations\/([^/]+)\/([^/]+)\/?$/);
      if (!m) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const room = decodeURIComponent(m[1]);
      const lang = decodeURIComponent(m[2]).toLowerCase();
      const k = subKey(room, lang);

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.write("retry: 3000\n\n");

      // Warm the subscriber with the last known line so a late joiner
      // sees the sentence in progress rather than nothing.
      const seed = last.get(k);
      if (seed) res.write("data: " + JSON.stringify(seed) + "\n\n");

      let set = subs.get(k);
      if (!set) {
        set = new Set();
        subs.set(k, set);
      }
      set.add(res);

      const prevRoomCount = roomSubCount.get(room) ?? 0;
      roomSubCount.set(room, prevRoomCount + 1);
      if (prevRoomCount === 0 && onFirstHook) {
        try {
          onFirstHook(room);
        } catch (e) {
          console.error("[sse] onFirstSubscriberForRoom threw:", e);
        }
      }

      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* onclose handles */
        }
      }, 15_000);

      req.on("close", () => {
        clearInterval(ping);
        set!.delete(res);
        if (set!.size === 0) subs.delete(k);
        const next = (roomSubCount.get(room) ?? 1) - 1;
        if (next <= 0) {
          roomSubCount.delete(room);
          if (onLastHook) {
            try {
              onLastHook(room);
            } catch (e) {
              console.error("[sse] onLastSubscriberForRoom threw:", e);
            }
          }
        } else {
          roomSubCount.set(room, next);
        }
      });
    });
  });

  server.listen(port, () => {
    console.log(`[sse] listening on :${port}`);
  });
}

import http from "node:http";
import cors from "cors";

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

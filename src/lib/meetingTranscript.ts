import { kv } from "@/lib/kv";
import type { TranscriptLine } from "@/lib/catchUp";

/**
 * The running transcript of a meeting, for "What did I miss?".
 *
 * A meeting's captions reach each browser straight from the LiveKit captions
 * agent; nothing on the server kept them. Participants' pages now send the
 * finished sentences here. Several pages send the same sentence, so each is
 * stored once under its caption segment id (first writer wins).
 *
 *   neo:meeting:tx:<room>   hash  segmentId → { s: speaker, t: text, ts }
 */

const MAX_SEGMENTS = 4000;
const TTL_SECONDS = 24 * 60 * 60;

const txKey = (room: string) => `neo:meeting:tx:${room}`;

export interface IncomingSegment {
  id: string;
  speaker: string;
  text: string;
}

interface Stored {
  s: string;
  t: string;
  ts: number;
}

export function cleanRoom(raw: string | null | undefined): string {
  return String(raw ?? "").trim().replace(/[^a-zA-Z0-9._#:-]/g, "").slice(0, 128);
}

/** Store finished caption sentences; returns how many were new. */
export async function addSegments(room: string, segs: IncomingSegment[], now = Date.now()): Promise<number> {
  if (!room || !segs.length) return 0;
  const key = txKey(room);
  if ((await kv.hlen(key)) >= MAX_SEGMENTS) return 0;
  let added = 0;
  for (const seg of segs.slice(0, 50)) {
    const id = String(seg.id ?? "").slice(0, 120);
    const text = String(seg.text ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
    if (!id || !text) continue;
    const value: Stored = { s: String(seg.speaker ?? "").trim().slice(0, 60), t: text, ts: now };
    added += Number(await kv.hsetnx(key, id, JSON.stringify(value)));
  }
  if (added) await kv.expire(key, TTL_SECONDS);
  return added;
}

/** The meeting's transcript as catch-up lines, oldest first. */
export async function meetingLines(room: string): Promise<TranscriptLine[]> {
  const all = await kv.hgetall<Record<string, Stored | string>>(txKey(room));
  if (!all) return [];
  const rows = Object.values(all)
    .map((v) => (typeof v === "string" ? (JSON.parse(v) as Stored) : v))
    .filter((v) => v && typeof v.t === "string")
    .sort((a, b) => a.ts - b.ts);
  return rows.map((r, i) => ({ seq: i + 1, ts: r.ts, text: r.s ? `${r.s}: ${r.t}` : r.t }));
}

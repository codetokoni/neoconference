// src/lib/replayRecordings.ts
//
// A meeting's recordings for its public replay page: anyone with the link
// may watch, as the owner decided. Egress writes them to R2 under
// recordings/<recorder>/<slug>/<yyyy-mm-dd-hh-mm-ss>.mp4, one video and one
// audio sidecar each; the page gets the videos, newest first, each with a
// signed address good for six hours. The page gets each recording's time,
// size and address. The address is R2's own, so it carries the stored key,
// which includes the recorder's account id — an opaque Clerk id, not a
// name or email; the same address the dashboard's Download uses.

import type { NeoEvent } from "@/types/event";
import { isVideoKey, listEventRecordingObjects } from "@/lib/eventRecordings";
import { isR2Configured, signGetUrl } from "@/lib/r2";

export type ReplayVideo = {
  /** When it was recorded (from the key), or null when the key is odd. */
  recordedAt: string | null;
  sizeBytes: number;
  /** A signed R2 address (key included); expires, so the page renders per request. */
  url: string;
};

/** Six hours: a replay left open through a service must still seek. */
export const REPLAY_URL_SECONDS = 6 * 60 * 60;

/** The recording time in a key's last segment, as ISO, or null. */
export function recordedAtFromKey(key: string): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.mp4$/i.exec(key);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * The videos among stored objects, newest first, sidecars and empties
 * left out. Pure, so it can be tested without R2.
 */
export function replayVideoKeys(objects: Array<{ key: string; size: number }>): Array<{ key: string; size: number }> {
  const seen = new Set<string>();
  return objects
    .filter((o) => o.size > 0 && isVideoKey(o.key))
    .filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)))
    .sort((a, b) => (recordedAtFromKey(b.key) || "").localeCompare(recordedAtFromKey(a.key) || "") || b.key.localeCompare(a.key));
}

export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

/** This meeting's recordings for the replay page. Empty without storage. */
export async function eventReplayVideos(ev: NeoEvent, max = 50): Promise<ReplayVideo[]> {
  if (!isR2Configured()) return [];
  const slugs = Array.from(new Set([ev.slug, ...(ev.aliasSlugs || [])]));
  const listed = await Promise.all(slugs.map((s) => listEventRecordingObjects(ev, max, s).catch(() => [])));
  const videos = replayVideoKeys(listed.flat());
  return Promise.all(
    videos.map(async (o) => ({
      recordedAt: recordedAtFromKey(o.key),
      sizeBytes: o.size,
      url: await signGetUrl(o.key, REPLAY_URL_SECONDS),
    }))
  );
}

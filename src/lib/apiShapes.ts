// src/lib/apiShapes.ts
//
// What the developer API (/api/v1) returns for events and recordings, built
// from the website's own records so the two can't drift: events from
// eventStore (the meetings people make on neoconference.app), recordings
// from where egress writes them in R2 (lib/roomRecording.ts).
//
// The first version read 'event:<slug>' and 'recordings/<meeting id>/',
// which nothing ever wrote: every events call came back empty or 404 and
// every recordings list empty (found 8 Oct 2026).

import type { NeoEvent } from "@/types/event";
import { isAudioKey, sanitizeSegment } from "@/lib/eventRecordings";
import { recordedAtFromKey, replayOpen } from "@/lib/replayRecordings";

const SITE = "https://www.neoconference.app";

/** How long a recording's download link works, in seconds. */
export const DOWNLOAD_URL_SECONDS = 3600;

export interface ApiEvent {
  slug: string;
  title: string;
  state: NeoEvent["state"];
  visibility: NeoEvent["visibility"];
  /** Where people join it. */
  url: string;
  createdAt: string;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The public replay page, when the owner leaves replays on; else null. */
  replayUrl: string | null;
}

export function apiEvent(ev: NeoEvent): ApiEvent {
  return {
    slug: ev.slug,
    title: ev.name,
    state: ev.state,
    visibility: ev.visibility,
    url: `${SITE}/e/${encodeURIComponent(ev.slug)}`,
    createdAt: ev.createdAt,
    scheduledAt: ev.scheduledAt ?? null,
    startedAt: ev.startedAt ?? null,
    endedAt: ev.endedAt ?? null,
    replayUrl: replayOpen(ev) ? `${SITE}/e/${encodeURIComponent(ev.slug)}/replay` : null,
  };
}

export interface ApiRecording {
  key: string;
  /** The grid video, or its audio-only sidecar. */
  kind: "video" | "audio";
  sizeBytes: number;
  /** When it was recorded, from the file name; null for an odd key. */
  recordedAt: string | null;
  downloadUrl: string;
  downloadUrlExpiresIn: number;
}

/**
 * Stored objects as the API lists them: empties left out, newest first,
 * each with a download link made by `sign`.
 */
export async function apiRecordings(
  objects: Array<{ key: string; size: number }>,
  sign: (key: string, expiresIn: number) => Promise<string>
): Promise<ApiRecording[]> {
  const kept = objects
    .filter((o) => o.size > 0)
    .map((o) => ({ ...o, recordedAt: recordedAtFromKey(o.key.replace(/\.m4a(\.mp4)?$/i, ".mp4")) }))
    .sort((a, b) => (b.recordedAt || "").localeCompare(a.recordedAt || "") || a.key.localeCompare(b.key));
  return Promise.all(
    kept.map(async (o) => ({
      key: o.key,
      kind: isAudioKey(o.key) ? ("audio" as const) : ("video" as const),
      sizeBytes: o.size,
      recordedAt: o.recordedAt,
      downloadUrl: await sign(o.key, DOWNLOAD_URL_SECONDS),
      downloadUrlExpiresIn: DOWNLOAD_URL_SECONDS,
    }))
  );
}

/**
 * Where an API meeting's recordings are: recorded through the API, the
 * files go in the key owner's folder under the meeting's room name (its
 * slug), the layout roomRecording.ts writes.
 */
export function meetingRecordingPrefix(ownerUserId: string, slug: string): string {
  return `recordings/${sanitizeSegment(ownerUserId)}/${sanitizeSegment(slug)}/`;
}

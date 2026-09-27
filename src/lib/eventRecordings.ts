// src/lib/eventRecordings.ts
//
// Where a meeting's recordings are, and which of them have transcripts.
//
// Egress writes 'recordings/<recorder userId>/<event slug>/<timestamp>.mp4',
// and any host may have been the one who pressed Record, so a meeting's
// files are the union of those prefixes over the owner and every elevated
// participant. Transcription jobs are indexed by that recording key, not by
// the meeting — so this is also the only way from a meeting to its
// transcripts. Shared by /api/recordings and the meeting summary.

import { listRecordings } from "@/lib/r2";
import { getMeetingParticipants } from "@/lib/meeting-roles";
import { transcribeStore } from "@/lib/transcribeStore";
import type { NeoEvent } from "@/types/event";

export interface StoredObject {
  key: string;
  size: number;
  lastModified?: string;
}

/**
 * Sanitize a path segment the same way egress/start/route.ts does, so the
 * prefix computed here matches the one the recording was written under.
 */
export function sanitizeSegment(s: string): string {
  return (
    (s || "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "x"
  );
}

export function userPrefix(userId: string): string {
  return "recordings/" + sanitizeSegment(userId) + "/";
}

/**
 * LiveKit egress writes audio sidecars as "<basename>.m4a.mp4" (older runs
 * produced bare "<basename>.m4a"). Both are audio, not a separate video.
 */
export function isAudioKey(k: string): boolean {
  return /\.m4a(?:\.mp4)?$/i.test(k);
}

export function stripAudioExt(k: string): string {
  return k.replace(/\.m4a(?:\.mp4)?$/i, "");
}

/** Whether a stored object is a meeting's video (not an audio sidecar). */
export function isVideoKey(k: string): boolean {
  return /\.mp4$/i.test(k) && !isAudioKey(k);
}

/**
 * Every non-empty stored object recorded for this meeting, across the
 * prefixes of everyone who could have recorded it.
 */
export async function listEventRecordingObjects(
  ev: NeoEvent,
  max: number,
  /** The slug the files were written under; a renamed meeting's old one. */
  slug: string = ev.slug
): Promise<StoredObject[]> {
  const eventSeg = sanitizeSegment(slug);
  const candidateIds = new Set<string>();
  if (ev.ownerUserId?.startsWith("user_")) candidateIds.add(ev.ownerUserId);
  // Everyone in the meeting-roles hash with rank >= moderator is a
  // plausible recorder. Skip anyone who isn't a Clerk user id (email rows
  // can't have written R2 keys).
  const participants = await getMeetingParticipants(ev.id, ev);
  for (const p of participants) {
    if (!p.userId?.startsWith("user_")) continue;
    if (p.role === "owner" || p.role === "host" || p.role === "moderator") {
      candidateIds.add(p.userId);
    }
  }

  const perPrefixMax = Math.max(20, Math.floor(max / Math.max(1, candidateIds.size)));
  const collected = new Map<string, StoredObject>();
  for (const uid of candidateIds) {
    const prefix = "recordings/" + sanitizeSegment(uid) + "/" + eventSeg + "/";
    const items = await listRecordings(prefix, perPrefixMax);
    for (const o of items) {
      if (o.size > 0 && !collected.has(o.key)) collected.set(o.key, o);
    }
  }
  return Array.from(collected.values());
}

/**
 * The finished transcripts of this meeting's recordings, oldest recording
 * first (keys end in the recording's timestamp).
 */
export async function eventTranscripts(
  ev: NeoEvent,
  max = 100
): Promise<Array<{ recordingKey: string; text: string }>> {
  const objects = await listEventRecordingObjects(ev, max);
  const keys = objects.map((o) => o.key).filter(isVideoKey).sort();
  const jobs = await transcribeStore.getByRecordingKeys(keys);
  const out: Array<{ recordingKey: string; text: string }> = [];
  for (const key of keys) {
    const job = jobs.get(key);
    if (job?.status === "done" && typeof job.text === "string" && job.text.trim()) {
      out.push({ recordingKey: key, text: job.text.trim() });
    }
  }
  return out;
}

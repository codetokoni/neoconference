// src/lib/ops/media.ts
//
// Media pipeline health: uploads, recordings, streaming, translation and
// transcription — counts and the recent failures.
//
// Uploads and recordings are counted as they happen (recordMediaEvent from
// the upload routes and the LiveKit webhook's egress_ended). Transcription
// is read from the jobs themselves (neo:transcribe:<id>, kept 30 days).
// Streaming and translation are asked live: AMS for what is broadcasting
// against what should be (the main programme and any featured stream), the
// translation worker for its per-room errors.
//
//   neo:ops:media:n:<YYYY-MM-DD>   hash "<kind>:ok" | "<kind>:failed" -> count (40 days)
//   neo:ops:media:fail:<kind>      list of recent failures, newest first, 50

import { kv } from "@/lib/kv";
import { AMS_REST, SIMULCAST_MAIN, isSurelyBroadcasting, videoChannelForRoom, type FeaturedState } from "@/lib/simulcast";
import type { TranscribeJob } from "@/lib/transcribe";
import { usageMonth } from "@/lib/recordingUsage";
import { dayKey, parseJson, pushCapped, readList, redact, scanKeys } from "@/lib/ops/util";

export type MediaKind = "upload" | "recording";

export interface MediaFailure {
  at: number;
  kind: MediaKind | "transcription";
  ref: string;
  detail: string;
}

const dayHash = (d: string) => `neo:ops:media:n:${d}`;
const failKey = (k: string) => `neo:ops:media:fail:${k}`;

/** Count one upload or recording outcome. Never throws — it runs inside the routes that do the work. */
export async function recordMediaEvent(kind: MediaKind, ok: boolean, ref: string, detail?: string): Promise<void> {
  try {
    const now = Date.now();
    const key = dayHash(dayKey(now));
    await kv.hincrby(key, `${kind}:${ok ? "ok" : "failed"}`, 1);
    await kv.expire(key, 40 * 24 * 60 * 60);
    if (!ok) {
      await pushCapped(failKey(kind), { at: now, kind, ref: ref.slice(0, 200), detail: redact(detail ?? "failed") } satisfies MediaFailure, 50);
    }
  } catch (e) {
    console.warn("[ops-media] record failed", kind, e instanceof Error ? e.message : e);
  }
}

/** LiveKit's EgressStatus, as a number or its name. */
export function egressOutcome(status: unknown, error?: string): { ok: boolean; label: string } {
  const names = ["EGRESS_STARTING", "EGRESS_ACTIVE", "EGRESS_ENDING", "EGRESS_COMPLETE", "EGRESS_FAILED", "EGRESS_ABORTED", "EGRESS_LIMIT_REACHED"];
  const label = typeof status === "number" ? names[status] ?? String(status) : String(status ?? "");
  const ok = !error && (label === "EGRESS_COMPLETE" || label === "");
  return { ok, label: label || "unknown" };
}

export interface DayCounts {
  day: string;
  upload: { ok: number; failed: number };
  recording: { ok: number; failed: number };
}

async function dailyCounts(days: number, now: number): Promise<DayCounts[]> {
  const out: DayCounts[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = dayKey(now - i * 86_400_000);
    const h = ((await kv.hgetall(dayHash(d))) ?? {}) as Record<string, unknown>;
    const n = (f: string) => Number(h[f] ?? 0) || 0;
    out.push({
      day: d,
      upload: { ok: n("upload:ok"), failed: n("upload:failed") },
      recording: { ok: n("recording:ok"), failed: n("recording:failed") },
    });
  }
  return out;
}

export interface TranscriptionSummary {
  total: number;
  byStatus: Record<string, number>;
  failureRate: number | null;
  recentFailures: MediaFailure[];
  queued: Array<{ id: string; status: string; provider: string; recordingKey?: string; updatedAt?: string; createdAt?: string }>;
  truncated: boolean;
}

/** Every transcription job still in KV (30 days), by status. */
export async function transcriptionJobs(cap = 2000): Promise<TranscriptionSummary> {
  const { keys, truncated } = await scanKeys("neo:transcribe:*", cap * 2);
  const allJobKeys = keys.filter((k) => !k.startsWith("neo:transcribe:key:"));
  const jobKeys = allJobKeys.slice(0, cap);
  const jobs = (await Promise.all(jobKeys.map(async (k) => parseJson<TranscribeJob>(await kv.get(k))))).filter((j): j is TranscribeJob => !!j);
  const byStatus: Record<string, number> = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
  const finished = (byStatus.done ?? 0) + (byStatus.error ?? 0);
  const ts = (j: TranscribeJob) => Date.parse(j.updatedAt || j.createdAt || "") || 0;
  const recentFailures = jobs
    .filter((j) => j.status === "error")
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, 20)
    .map((j) => ({ at: ts(j), kind: "transcription" as const, ref: j.recordingKey || j.id, detail: redact(j.error || "error") }));
  const queued = jobs
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, 50)
    .map((j) => ({ id: j.id, status: j.status, provider: j.provider, recordingKey: j.recordingKey, updatedAt: j.updatedAt, createdAt: j.createdAt }));
  return {
    total: jobs.length,
    byStatus,
    failureRate: finished ? (byStatus.error ?? 0) / finished : null,
    recentFailures,
    queued,
    truncated: truncated || allJobKeys.length > cap,
  };
}

export interface StreamingSummary {
  reachable: boolean;
  detail: string;
  liveStreams: number | null;
  expected: Array<{ room: string; streamId: string; why: string; live: boolean }>;
}

export async function streamingStatus(): Promise<StreamingSummary> {
  let liveStreams: number | null = null;
  let reachable = false;
  let detail = "";
  try {
    const r = await fetch(`${AMS_REST}/broadcasts/active-live-stream-count`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    reachable = r.ok;
    if (r.ok) liveStreams = Number(((await r.json().catch(() => ({}))) as { number?: number }).number ?? 0);
    detail = r.ok ? "AMS REST answered" : `AMS REST HTTP ${r.status}`;
  } catch (e) {
    detail = redact(e instanceof Error ? e.message : String(e));
  }
  const expected: StreamingSummary["expected"] = [];
  const main = videoChannelForRoom(SIMULCAST_MAIN).id;
  expected.push({ room: SIMULCAST_MAIN, streamId: main, why: "main programme", live: await isSurelyBroadcasting(main) });
  const { keys } = await scanKeys("neo:video:featured:*", 200);
  for (const k of keys) {
    const f = parseJson<FeaturedState>(await kv.get(k));
    if (!f?.streamId) continue;
    expected.push({ room: k.slice("neo:video:featured:".length), streamId: f.streamId, why: `featured: ${f.label || f.streamId}`, live: await isSurelyBroadcasting(f.streamId) });
  }
  return { reachable, detail, liveStreams, expected };
}

export interface TranslationSummary {
  configured: boolean;
  reachable: boolean;
  detail: string;
  rooms: Array<{ room: string; charsTotal: number; errorsTotal: number; errorsWindow: number; lastErrorAt: number | null; lastErrorMessage: string | null }>;
}

export async function translationStatus(): Promise<TranslationSummary> {
  const base = (process.env.NEXT_PUBLIC_TRANSLATION_SSE || process.env.TRANSLATION_SSE || "").trim().replace(/\/$/, "");
  if (!base) return { configured: false, reachable: false, detail: "NEXT_PUBLIC_TRANSLATION_SSE is not set", rooms: [] };
  try {
    const r = await fetch(`${base}/stats`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { configured: true, reachable: false, detail: `stats HTTP ${r.status}`, rooms: [] };
    const j = (await r.json().catch(() => ({}))) as { rooms?: TranslationSummary["rooms"] };
    const rooms = (Array.isArray(j.rooms) ? j.rooms : []).map((x) => ({
      room: String(x.room),
      charsTotal: Number(x.charsTotal ?? 0),
      errorsTotal: Number(x.errorsTotal ?? 0),
      errorsWindow: Number(x.errorsWindow ?? 0),
      lastErrorAt: x.lastErrorAt ?? null,
      lastErrorMessage: x.lastErrorMessage ? redact(String(x.lastErrorMessage)) : null,
    }));
    return { configured: true, reachable: true, detail: "worker answered (counts reset when the worker restarts)", rooms };
  } catch (e) {
    return { configured: true, reachable: false, detail: redact(e instanceof Error ? e.message : String(e)), rooms: [] };
  }
}

/** Recorded hours this month across every owner (lib/recordingUsage), for the recording-quota alert. */
export async function recordedHoursThisMonth(now = Date.now()): Promise<{ month: string; hours: number; owners: number; truncated: boolean }> {
  const month = usageMonth(now);
  const { keys, truncated } = await scanKeys("neo:rec-usage:*", 5000);
  let seconds = 0;
  let owners = 0;
  for (const k of keys) {
    const v = Number((await kv.hget(k, month)) ?? 0) || 0;
    if (v > 0) owners++;
    seconds += v;
  }
  return { month, hours: seconds / 3600, owners, truncated };
}

export async function mediaSummary(days = 7, now = Date.now()) {
  const [counts, uploadFailures, recordingFailures, transcription, streaming, translation, recordedThisMonth] = await Promise.all([
    dailyCounts(days, now),
    readList<MediaFailure>(failKey("upload"), 20),
    readList<MediaFailure>(failKey("recording"), 20),
    transcriptionJobs(),
    streamingStatus(),
    translationStatus(),
    recordedHoursThisMonth(now),
  ]);
  return { generatedAt: now, days: counts, uploadFailures, recordingFailures, transcription, streaming, translation, recordedThisMonth };
}

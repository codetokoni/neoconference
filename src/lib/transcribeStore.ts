// src/lib/transcribeStore.ts
//
// KV-backed persistence for TranscribeJob objects so /api/transcribe?id=...
// can rehydrate jobs across requests / lambdas. Falls back to an in-memory
// Map when Vercel KV is not configured.
//
// Keys:
//   neo:transcribe:<jobId>          -> TranscribeJob JSON  (primary, 30d TTL)
//   neo:transcribe:key:<b64-key>    -> <jobId>             (secondary index)
//
// The secondary index lets the recordings list lookup "is there a transcript
// for this R2 key?" without scanning. We base64-url-encode the recording key
// because KV keys must be opaque ASCII and recording paths contain slashes.

import { kv } from '@vercel/kv';
import type { TranscribeJob } from '@/lib/transcribe';

const PREFIX = 'neo:transcribe:';
const KEY_INDEX_PREFIX = 'neo:transcribe:key:';
// 30 days is long enough that any meeting played back within the month shows
// its transcript; KV cost is negligible (transcripts are short text).
const TTL_SECONDS = 60 * 60 * 24 * 30;

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  );
}

// In-memory fallback (per-process, NOT durable across deploys / lambdas).
const memJobs = new Map<string, TranscribeJob>();
const memByKey = new Map<string, string>(); // recordingKey -> jobId

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[neo:transcribeStore] Vercel KV is not configured - jobs are kept in-memory only.'
  );
}

function encodeRecordingKey(recordingKey: string): string {
  // Standard base64 → URL-safe (KV keys are ASCII so this is just paranoia
  // against future colon-aware adapters).
  const b64 = Buffer.from(recordingKey, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const transcribeStore = {
  isConfigured: isKvConfigured,

  async put(job: TranscribeJob): Promise<TranscribeJob> {
    if (!isKvConfigured()) {
      warnOnce();
      memJobs.set(job.id, job);
      if (job.recordingKey) memByKey.set(job.recordingKey, job.id);
      return job;
    }
    await kv.set(PREFIX + job.id, job, { ex: TTL_SECONDS });
    if (job.recordingKey) {
      await kv.set(KEY_INDEX_PREFIX + encodeRecordingKey(job.recordingKey), job.id, {
        ex: TTL_SECONDS,
      });
    }
    return job;
  },

  async get(id: string): Promise<TranscribeJob | null> {
    if (!isKvConfigured()) {
      return memJobs.get(id) ?? null;
    }
    const v = await kv.get<TranscribeJob>(PREFIX + id);
    return v ?? null;
  },

  /**
   * Lookup the most recent transcribe job for a given R2 recording key.
   * Returns null if none exists. Cheap: 2 KV gets in the worst case.
   */
  async getByRecordingKey(recordingKey: string): Promise<TranscribeJob | null> {
    if (!recordingKey) return null;
    if (!isKvConfigured()) {
      const id = memByKey.get(recordingKey);
      return id ? memJobs.get(id) ?? null : null;
    }
    const id = await kv.get<string>(KEY_INDEX_PREFIX + encodeRecordingKey(recordingKey));
    if (!id) return null;
    const v = await kv.get<TranscribeJob>(PREFIX + id);
    return v ?? null;
  },

  /**
   * Batch variant: fetches transcripts for many recording keys in parallel.
   * Returns a Map keyed by recordingKey so callers can join into a list.
   */
  async getByRecordingKeys(recordingKeys: string[]): Promise<Map<string, TranscribeJob>> {
    const out = new Map<string, TranscribeJob>();
    if (recordingKeys.length === 0) return out;
    const results = await Promise.all(
      recordingKeys.map(async (k) => [k, await this.getByRecordingKey(k)] as const)
    );
    for (const [k, job] of results) {
      if (job) out.set(k, job);
    }
    return out;
  },

  async delete(id: string): Promise<boolean> {
    if (!isKvConfigured()) {
      const j = memJobs.get(id);
      if (j?.recordingKey) memByKey.delete(j.recordingKey);
      return memJobs.delete(id);
    }
    const j = await this.get(id);
    await kv.del(PREFIX + id);
    if (j?.recordingKey) {
      await kv.del(KEY_INDEX_PREFIX + encodeRecordingKey(j.recordingKey));
    }
    return true;
  },
};

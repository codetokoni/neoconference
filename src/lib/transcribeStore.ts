// src/lib/transcribeStore.ts
//
// KV-backed persistence for TranscribeJob objects so /api/transcribe?id=...
// can rehydrate jobs across requests / lambdas. Falls back to an in-memory
// Map when Vercel KV is not configured.
//
// Keys: neo:transcribe:<jobId> -> TranscribeJob JSON

import { kv } from '@vercel/kv';
import type { TranscribeJob } from '@/lib/transcribe';

const PREFIX = 'neo:transcribe:';

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  );
}

// In-memory fallback (per-process, NOT durable across deploys / lambdas).
const memJobs = new Map<string, TranscribeJob>();

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[neo:transcribeStore] Vercel KV is not configured - jobs are kept in-memory only.'
  );
}

export const transcribeStore = {
  isConfigured: isKvConfigured,

  async put(job: TranscribeJob): Promise<TranscribeJob> {
    if (!isKvConfigured()) {
      warnOnce();
      memJobs.set(job.id, job);
      return job;
    }
    // 24h TTL is plenty for polling; transcripts are mirrored onto NeoEvent.recordings.
    await kv.set(PREFIX + job.id, job, { ex: 60 * 60 * 24 });
    return job;
  },

  async get(id: string): Promise<TranscribeJob | null> {
    if (!isKvConfigured()) {
      return memJ
obs.get(id) ?? null;
    }
    const v = await kv.get<TranscribeJob>(PREFIX + id);
    return v ?? null;
  },

  async delete(id: string): Promise<boolean> {
    if (!isKvConfigured()) {
      return memJobs.delete(id);
    }
    await kv.del(PREFIX + id);
    return true;
  },
};

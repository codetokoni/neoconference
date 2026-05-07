// src/lib/transcribe.ts
//
// Transcription provider abstraction. Pluggable so we can swap between
// LiveKit Transcription (built-in), OpenAI Whisper, Deepgram, or AssemblyAI
// without touching call sites.
//
// Active providers:
//   - 'stub'   : default, returns 'queued' forever. Useful for UI scaffolding.
//   - 'openai' : OpenAI Whisper API. Set TRANSCRIBE_PROVIDER=openai +
//                OPENAI_API_KEY in env. Synchronous - returns 'done' with
//                full transcript text on the same call.
// Future: 'livekit', 'deepgram', 'assemblyai' - shape preserved.
//
// Persistence: jobs are written to transcribeStore (KV-backed) so callers
// can poll GET /api/transcribe?id=<jobId> after submit.

import { signGetUrl, isR2Configured } from '@/lib/r2';
import { transcribeStore } from '@/lib/transcribeStore';

export type TranscribeJob = {
  /** Unique job id (used for polling / cancellation). */
  id: string;
  /** R2 object key of the source recording. */
  recordingKey: string;
  /** Owner event slug (so we can attach the artifact when the job finishes). */
  eventSlug?: string;
  /** ISO 639-1 language hint (e.g. "en", "fr"). */
  language?: string;
  /** Provider used for the job. */
  provider: TranscribeProvider;
  /** Lifecycle. */
  status: 'queued' | 'running' | 'done' | 'error';
  /** Final transcript text (only set when status === 'done'). */
  text?: string;
  /** Provider-specific error message. */
  error?: string;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
};

export type TranscribeProvider =
  | 'livekit'
  | 'openai'
  | 'deepgram'
  | 'assemblyai'
  | 'stub';

/**
 * Returns the configured provider, or 'stub' when none is set or when
 * the chosen provider is missing its API key.
 */
export function getTranscribeProvider(): TranscribeProvider {
  const v = (process.env.TRANSCRIBE_PROVIDER || '').toLowerCase();
  if (v === 'openai') {
    return process.env.OPENAI_API_KEY ? 'openai' : 'stub';
  }
  if (v === 'livekit' || v === 'deepgram' || v === 'assemblyai') {
    // Not implemented yet, fall through to stub.
    return 'stub';
  }
  return 'stub';
}

export function isTranscribeConfigured(): boolean {
  return getTranscribeProvider() !== 'stub';
}

/**
 * Submit a transcription job. When provider is configured, the job runs
 * synchronously and the returned object has status='done' + .text. In
 * stub mode the job returns 'queued' and never advances.
 *
 * Every job is persisted to transcribeStore (queued, then again on done/error)
 * so callers can poll GET /api/transcribe?id=<jobId>.
 */
export async function submitTranscribeJob(input: {
  recordingKey: string;
  eventSlug?: string;
  language?: string;
}): Promise<TranscribeJob> {
  const provider = getTranscribeProvider();
  const now = new Date().toISOString();
  const baseJob: TranscribeJob = {
    id: cryptoRandomId(),
    recordingKey: input.recordingKey,
    eventSlug: input.eventSlug,
    language: input.language,
    provider,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
  // Persist immediately so polling works even before provider returns.
  await transcribeStore.put(baseJob);

  if (provider === 'openai') {
    const finished = await runOpenAIWhisper(baseJob);
    await transcribeStore.put(finished);
    return finished;
  }

  // Stub or unimplemented provider - return queued placeholder.
  return baseJob;
}

/**
 * Look up a job by id. Returns the persisted job from transcribeStore,
 * or null if not found / KV not configured and the job has rotated out
 * of the in-memory cache.
 */
export async function getTranscribeJob(id: string): Promise<TranscribeJob | null> {
  return transcribeStore.get(id);
}

// ---------- providers ----------

/**
 * OpenAI Whisper provider. Fetches the recording from R2, streams it to
 * the Whisper API, and returns a 'done' job with the full transcript text.
 *
 * Limits: Whisper accepts files up to 25 MB. Larger recordings will fail
 * with a clear error message. We can add chunked upload in a follow-up.
 */
async function runOpenAIWhisper(job: TranscribeJob): Promise<TranscribeJob> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ...job, status: 'error', error: 'OPENAI_API_KEY missing', updatedAt: new Date().toISOString() };
  }
  if (!isR2Configured()) {
    return { ...job, status: 'error', error: 'R2 not configured - cannot fetch recording', updatedAt: new Date().toISOString() };
  }

  try {
    // 1. Get a short-lived signed URL for the R2 object.
    const signed = await signGetUrl(job.recordingKey, 600);
    if (!signed) {
      return { ...job, status: 'error', error: 'Could not sign R2 URL', updatedAt: new Date().toISOString() };
    }

    // 2. Stream-fetch the recording.
    const fileRes = await fetch(signed);
    if (!fileRes.ok) {
      return { ...job, status: 'error', error: 'R2 fetch ' + fileRes.status, updatedAt: new Date().toISOString() };
    }
    const blob = await fileRes.blob();

    // Whisper API has a 25 MB hard limit.
    if (blob.size > 25 * 1024 * 1024) {
      return {
        ...job,
        status: 'error',
        error: 'File too large for Whisper (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB > 25 MB)',
        updatedAt: new Date().toISOString(),
      };
    }

    // 3. POST to Whisper.
    const filename = job.recordingKey.split('/').pop() || 'recording.mp4';
    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('model', 'whisper-1');
    if (job.language) fd.append('language', job.language);
    fd.append('response_format', 'json');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: fd,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ...job,
        status: 'error',
        error: 'Whisper ' + res.status + ': ' + errText.slice(0, 200),
        updatedAt: new Date().toISOString(),
      };
    }
    const j = (await res.json()) as { text?: string };
    return {
      ...job,
      status: 'done',
      text: j.text || '',
      updatedAt: new Date().toISOString(),
    };
  } catch (e: unknown) {
    return {
      ...job,
      status: 'error',
      error: e instanceof Error ? e.message : 'Unknown transcribe error',
      updatedAt: new Date().toISOString(),
    };
  }
}

// ---------- helpers ----------

function cryptoRandomId(): string {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c?.randomUUID) return c.randomUUID();
    if (c?.getRandomValues) {
      const buf = new Uint8Array(16);
      c.getRandomValues(buf);
      return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // ignore
  }
  return 'job_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

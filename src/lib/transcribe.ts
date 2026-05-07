// src/lib/transcribe.ts
//
// Transcription provider abstraction. Pluggable so we can swap between
// LiveKit Transcription (built-in), OpenAI Whisper, Deepgram, or AssemblyAI
// without touching call sites.
//
// Active providers:
//   - 'stub'       : default, returns 'queued' forever. Useful for UI scaffolding.
//   - 'openai'     : OpenAI Whisper API. Set TRANSCRIBE_PROVIDER=openai +
//                    OPENAI_API_KEY in env. Synchronous - returns 'done' with
//                    full transcript text on the same call. 25 MB file cap.
//   - 'assemblyai' : AssemblyAI long-form. Set TRANSCRIBE_PROVIDER=assemblyai +
//                    ASSEMBLYAI_API_KEY in env. Ingests directly from R2 signed
//                    URL (no upload). Polls until 'completed' / 'error'. Handles
//                    multi-GB files for >25 MB recordings.
// Future: 'livekit', 'deepgram' - shape preserved.
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
  /** Provider-side job id, when the upstream API exposes one (e.g. AssemblyAI). */
  externalId?: string;
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
  if (v === 'assemblyai') {
    return process.env.ASSEMBLYAI_API_KEY ? 'assemblyai' : 'stub';
  }
  if (v === 'livekit' || v === 'deepgram') {
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

  if (provider === 'assemblyai') {
    const finished = await runAssemblyAI(baseJob);
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
 * with a clear error message - use the AssemblyAI provider for long-form.
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
    const signed = await signGetUrl(job.recordingKey, 600);
    if (!signed) {
      return { ...job, status: 'error', error: 'Could not sign R2 URL', updatedAt: new Date().toISOString() };
    }
    const fileRes = await fetch(signed);
    if (!fileRes.ok) {
      return { ...job, status: 'error', error: 'R2 fetch ' + fileRes.status, updatedAt: new Date().toISOString() };
    }
    const blob = await fileRes.blob();

    if (blob.size > 25 * 1024 * 1024) {
      return {
        ...job,
        status: 'error',
        error: 'File too large for Whisper (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB > 25 MB). Switch TRANSCRIBE_PROVIDER to assemblyai for long-form.',
        updatedAt: new Date().toISOString(),
      };
    }

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

/**
 * AssemblyAI long-form provider. Hands the API a signed R2 URL and polls
 * the resulting transcript id until it resolves to 'completed' or 'error'.
 *
 * Handles multi-GB recordings without buffering them through this lambda,
 * so it's the right choice when Whisper's 25 MB cap is too small.
 *
 * Polling cap: ~90 seconds (30 attempts x 3s). For longer files we'd return
 * a 'running' job with externalId so the caller can poll GET /api/transcribe
 * later, but most <2h recordings finish well under that cap.
 */
async function runAssemblyAI(job: TranscribeJob): Promise<TranscribeJob> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return { ...job, status: 'error', error: 'ASSEMBLYAI_API_KEY missing', updatedAt: new Date().toISOString() };
  }
  if (!isR2Configured()) {
    return { ...job, status: 'error', error: 'R2 not configured - cannot sign URL', updatedAt: new Date().toISOString() };
  }

  try {
    // 1. Sign a long-lived R2 URL (1h) so AssemblyAI's pipeline has time to ingest.
    const signed = await signGetUrl(job.recordingKey, 60 * 60);
    if (!signed) {
      return { ...job, status: 'error', error: 'Could not sign R2 URL', updatedAt: new Date().toISOString() };
    }

    // 2. Submit transcription job by audio URL (no upload).
    const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: signed,
        language_code: job.language || undefined,
        speaker_labels: true,
        punctuate: true,
        format_text: true,
      }),
    });
    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => '');
      return {
        ...job,
        status: 'error',
        error: 'AssemblyAI submit ' + submitRes.status + ': ' + errText.slice(0, 200),
        updatedAt: new Date().toISOString(),
      };
    }
    const submitJson = (await submitRes.json()) as { id?: string; error?: string };
    const externalId = submitJson.id;
    if (!externalId) {
      return {
        ...job,
        status: 'error',
        error: 'AssemblyAI returned no transcript id: ' + (submitJson.error || 'unknown'),
        updatedAt: new Date().toISOString(),
      };
    }

    // 3. Poll for completion. Bail after ~90s and return a 'running' job that
    //    upstream callers can re-poll via GET /api/transcribe?id=...
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(3000);
      const pollRes = await fetch('https://api.assemblyai.com/v2/transcript/' + externalId, {
        headers: { Authorization: apiKey },
      });
      if (!pollRes.ok) continue;
      const j = (await pollRes.json()) as { status?: string; text?: string; error?: string };
      if (j.status === 'completed') {
        return {
          ...job,
          status: 'done',
          text: j.text || '',
          externalId,
          updatedAt: new Date().toISOString(),
        };
      }
      if (j.status === 'error') {
        return {
          ...job,
          status: 'error',
          externalId,
          error: 'AssemblyAI: ' + (j.error || 'unknown'),
          updatedAt: new Date().toISOString(),
        };
      }
      // queued / processing - continue polling
    }

    // Polling cap reached - return a 'running' job so the client can re-poll.
    return {
      ...job,
      status: 'running',
      externalId,
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
  } catch (e: unknown) {
    return {
      ...job,
      status: 'error',
      error: e instanceof Error ? e.message : 'Unknown AssemblyAI error',
      updatedAt: new Date().toISOString(),
    };
  }
}

// ---------- helpers ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

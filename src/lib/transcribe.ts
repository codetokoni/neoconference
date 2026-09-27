// src/lib/transcribe.ts
//
// Transcription provider abstraction. Pluggable so we can swap between
// LiveKit Transcription (built-in), OpenAI Whisper, Deepgram, or AssemblyAI
// without touching call sites.
//
// Active providers:
// - 'stub' : default, returns 'queued' forever. Useful for UI scaffolding.
// - 'openai' : OpenAI Whisper API. 25 MB file cap.
// - 'assemblyai' : AssemblyAI long-form. R2 URL ingest (no upload).
// - 'deepgram' : Deepgram Nova-3 pre-recorded API. We stream the file from
//                R2 ourselves via the S3 SDK (bypasses presigned-URL quirks
//                where R2 occasionally returns SignatureDoesNotMatch) to
//                /v1/listen, and Deepgram posts the result back to
//                /api/transcribe/deepgram. Built-in summarize=v2 returns a
//                summary with it.
// Future: 'livekit' - shape preserved.
//
// Persistence: jobs are written to transcribeStore (KV-backed) so callers
// can poll GET /api/transcribe?id=<jobId> after submit.

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, isR2Configured, signGetUrl } from '@/lib/r2';
import { transcribeStore } from '@/lib/transcribeStore';
import {
  audioSidecarKeys,
  callbackUrl,
  jobFromDeepgram,
  type DeepgramResponse,
} from '@/lib/deepgramResult';

/**
 * One diarized utterance from the provider — a stretch of speech attributed
 * to a single speaker, with millisecond offsets from the start of the
 * recording. FRS §8.5 wants speaker names, timestamps, and paragraph
 * separation by speaker; segments are the shape that gets us all three
 * on a single pass. `speaker` is a raw label (0, 1, 2… from Deepgram; "A",
 * "B"… from AssemblyAI) — the export step turns those into "Speaker 1",
 * "Speaker 2" for display so downstream consumers stay provider-agnostic.
 */
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string | number;
}

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
  /** Diarized utterances with millisecond offsets and speaker labels. Empty
   *  or absent when the provider didn't return them or diarization was off. */
  segments?: TranscriptSegment[];
  /** Optional provider-generated summary (Deepgram summarize=v2; others may add). */
  summary?: string;
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

export function getTranscribeProvider(): TranscribeProvider {
  const v = (process.env.TRANSCRIBE_PROVIDER || '').toLowerCase();
  if (v === 'openai') return process.env.OPENAI_API_KEY ? 'openai' : 'stub';
  if (v === 'assemblyai') return process.env.ASSEMBLYAI_API_KEY ? 'assemblyai' : 'stub';
  if (v === 'deepgram') return process.env.DEEPGRAM_API_KEY ? 'deepgram' : 'stub';
  if (v === 'livekit') return 'stub';
  return 'stub';
}

export function isTranscribeConfigured(): boolean {
  return getTranscribeProvider() !== 'stub';
}

export async function submitTranscribeJob(input: {
  recordingKey: string;
  eventSlug?: string;
  language?: string;
  /**
   * This deployment's public origin, for providers that post their result
   * back (Deepgram). Without it they are waited on inline.
   */
  callbackUrlBase?: string;
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
  if (provider === 'deepgram') {
    const finished = await runDeepgram(baseJob, input.callbackUrlBase);
    // 'running' was stored before the upload began. Writing it again here
    // could land after Deepgram's callback and overwrite the transcript.
    if (finished.status !== 'running') await transcribeStore.put(finished);
    return finished;
  }
  return baseJob;
}

export async function getTranscribeJob(id: string): Promise<TranscribeJob | null> {
  return transcribeStore.get(id);
}

// ---------- providers ----------

async function runOpenAIWhisper(job: TranscribeJob): Promise<TranscribeJob> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ...job, status: 'error', error: 'OPENAI_API_KEY missing', updatedAt: new Date().toISOString() };
  if (!isR2Configured()) return { ...job, status: 'error', error: 'R2 not configured', updatedAt: new Date().toISOString() };
  try {
    const bytes = await getR2Bytes(job.recordingKey);
    if (bytes.byteLength > 25 * 1024 * 1024) {
      return { ...job, status: 'error', error: 'File too large for Whisper (' + (bytes.byteLength / 1024 / 1024).toFixed(1) + ' MB > 25 MB). Switch TRANSCRIBE_PROVIDER to deepgram for long-form.', updatedAt: new Date().toISOString() };
    }
    const filename = job.recordingKey.split('/').pop() || 'recording.mp4';
    const fd = new FormData();
    fd.append('file', new Blob([bytes]), filename);
    fd.append('model', 'whisper-1');
    if (job.language) fd.append('language', job.language);
    fd.append('response_format', 'json');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: fd });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ...job, status: 'error', error: 'Whisper ' + res.status + ': ' + errText.slice(0, 200), updatedAt: new Date().toISOString() };
    }
    const j = (await res.json()) as { text?: string };
    return { ...job, status: 'done', text: j.text || '', updatedAt: new Date().toISOString() };
  } catch (e: unknown) {
    return { ...job, status: 'error', error: e instanceof Error ? e.message : 'Unknown transcribe error', updatedAt: new Date().toISOString() };
  }
}

async function runAssemblyAI(job: TranscribeJob): Promise<TranscribeJob> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) return { ...job, status: 'error', error: 'ASSEMBLYAI_API_KEY missing', updatedAt: new Date().toISOString() };
  if (!isR2Configured()) return { ...job, status: 'error', error: 'R2 not configured', updatedAt: new Date().toISOString() };
  try {
    const signed = await signGetUrl(job.recordingKey, 60 * 60);
    if (!signed) return { ...job, status: 'error', error: 'Could not sign R2 URL', updatedAt: new Date().toISOString() };
    const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_url: signed, language_code: job.language || undefined, speaker_labels: true, punctuate: true, format_text: true }),
    });
    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => '');
      return { ...job, status: 'error', error: 'AssemblyAI submit ' + submitRes.status + ': ' + errText.slice(0, 200), updatedAt: new Date().toISOString() };
    }
    const submitJson = (await submitRes.json()) as { id?: string; error?: string };
    const externalId = submitJson.id;
    if (!externalId) return { ...job, status: 'error', error: 'AssemblyAI returned no transcript id: ' + (submitJson.error || 'unknown'), updatedAt: new Date().toISOString() };
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(3000);
      const pollRes = await fetch('https://api.assemblyai.com/v2/transcript/' + externalId, { headers: { Authorization: apiKey } });
      if (!pollRes.ok) continue;
      const j = (await pollRes.json()) as { status?: string; text?: string; error?: string };
      if (j.status === 'completed') {
        // AssemblyAI's utterances carry ms offsets (not seconds) and a
        // string speaker label ("A", "B", ...). Shape is otherwise
        // equivalent to Deepgram's.
        type AAUtt = { start?: number; end?: number; speaker?: string; text?: string };
        const utterances = ((j as { utterances?: AAUtt[] }).utterances || []) as AAUtt[];
        const segments: TranscriptSegment[] = utterances
          .filter((u) => typeof u.text === 'string' && u.text.trim().length > 0)
          .map((u) => ({
            startMs: typeof u.start === 'number' ? u.start : 0,
            endMs: typeof u.end === 'number' ? u.end : 0,
            text: (u.text || '').trim(),
            speaker: typeof u.speaker === 'string' ? u.speaker : undefined,
          }));
        return {
          ...job,
          status: 'done',
          text: j.text || '',
          segments: segments.length > 0 ? segments : undefined,
          externalId,
          updatedAt: new Date().toISOString(),
        };
      }
      if (j.status === 'error') return { ...job, status: 'error', externalId, error: 'AssemblyAI: ' + (j.error || 'unknown'), updatedAt: new Date().toISOString() };
    }
    return { ...job, status: 'running', externalId, error: undefined, updatedAt: new Date().toISOString() };
  } catch (e: unknown) {
    return { ...job, status: 'error', error: e instanceof Error ? e.message : 'Unknown AssemblyAI error', updatedAt: new Date().toISOString() };
  }
}

const DEEPGRAM_PARAMS: Record<string, string> = {
  model: 'nova-3',
  smart_format: 'true',
  punctuate: 'true',
  paragraphs: 'true',
  utterances: 'true',
  diarize: 'true',
  summarize: 'v2',
};

/**
 * Deepgram pre-recorded provider.
 *
 * Reads the recording from R2 with the S3 SDK — Deepgram fetching a signed
 * R2 URL itself failed with REMOTE_CONTENT_ERROR (727259b) — and streams it
 * to /v1/listen, preferring the audio-only sidecar, which is all Deepgram
 * needs and a fraction of the video.
 *
 * With a callback base, Deepgram answers at once with a request id and
 * posts the transcript to /api/transcribe/deepgram when it is done; the
 * job is 'running' until then. That is the normal path. Without one (no
 * public URL to call back, e.g. a local run) it waits for the transcript
 * in this request, as it always did — and a long recording can outlast
 * the function there.
 */
async function runDeepgram(job: TranscribeJob, callbackUrlBase?: string): Promise<TranscribeJob> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return { ...job, status: 'error', error: 'DEEPGRAM_API_KEY missing', updatedAt: new Date().toISOString() };
  if (!isR2Configured()) return { ...job, status: 'error', error: 'R2 not configured', updatedAt: new Date().toISOString() };

  try {
    const source = await openR2Source(job.recordingKey);

    const params = new URLSearchParams(DEEPGRAM_PARAMS);
    if (job.language) params.set('language', job.language);
    if (callbackUrlBase) params.set('callback', callbackUrl(callbackUrlBase, job.id, apiKey));
    const endpoint = 'https://api.deepgram.com/v1/listen?' + params.toString();

    const headers: Record<string, string> = {
      Authorization: 'Token ' + apiKey,
      // mp4 covers AAC-in-MP4, which is what egress writes for both files.
      'Content-Type': guessContentType(source.key),
    };
    if (source.length) headers['Content-Length'] = String(source.length);
    if (callbackUrlBase) {
      // Stored before the upload: the callback may arrive before this
      // request finishes, and must find the job running, not be undone.
      await transcribeStore.put({ ...job, status: 'running', updatedAt: new Date().toISOString() });
    }
    // eslint-disable-next-line no-console
    console.info('[transcribe] deepgram', {
      jobId: job.id,
      source: source.key,
      bytes: source.length,
      async: Boolean(callbackUrlBase),
    });
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: source.body,
      // Required by Node's fetch to send a stream as the request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ...job, status: 'error', error: 'Deepgram ' + res.status + ': ' + errText.slice(0, 300), updatedAt: new Date().toISOString() };
    }
    const body = (await res.json()) as DeepgramResponse;
    if (callbackUrlBase) {
      const externalId = body.request_id || body.metadata?.request_id;
      // eslint-disable-next-line no-console
      console.info('[transcribe] deepgram accepted', { jobId: job.id, requestId: externalId });
      return { ...job, status: 'running', externalId, updatedAt: new Date().toISOString() };
    }
    return jobFromDeepgram(job, body);
  } catch (e: unknown) {
    return { ...job, status: 'error', error: e instanceof Error ? e.message : 'Unknown Deepgram error', updatedAt: new Date().toISOString() };
  }
}

/**
 * The recording's audio sidecar if there is one, else the recording, as a
 * stream: nothing is held in memory, so size no longer matters here.
 */
async function openR2Source(
  recordingKey: string
): Promise<{ key: string; length?: number; body: ReadableStream<Uint8Array> }> {
  const s3 = r2Client();
  const Bucket = requireBucket();
  let key = recordingKey;
  for (const candidate of audioSidecarKeys(recordingKey)) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket, Key: candidate }));
      if ((head.ContentLength ?? 0) > 0) {
        key = candidate;
        break;
      }
    } catch {
      // Not there: try the next, then the recording itself.
    }
  }
  const out = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  const stream = (out.Body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined)
    ?.transformToWebStream?.();
  if (!stream) throw new Error('R2 object body missing for key ' + key);
  return { key, length: out.ContentLength, body: stream };
}



/**
 * Fetch an object from R2 via the SDK and return its body as an ArrayBuffer.
 * This bypasses presigned-URL signature pitfalls.
 */
async function getR2Bytes(key: string): Promise<ArrayBuffer> {
  const s3 = r2Client();
  const out = await s3.send(
    new GetObjectCommand({ Bucket: requireBucket(), Key: key })
  );
  const body = out.Body;
  if (!body) throw new Error('R2 object body missing for key ' + key);
  // body is a Node Readable stream in lambda runtimes; .transformToByteArray
  // is provided by @aws-sdk/util-stream which AWS SDK v3 ships with.
  const maybe = body as unknown as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybe.transformToByteArray === 'function') {
    const arr = await maybe.transformToByteArray();
    return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
  }
  // Fallback: collect a Node Readable stream manually.
  const stream = body as unknown as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of stream) {
    chunks.push(c);
    total += c.byteLength;
  }
  const out2 = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out2.set(c, offset); offset += c.byteLength; }
  return out2.buffer.slice(out2.byteOffset, out2.byteOffset + out2.byteLength) as ArrayBuffer;
}

function requireBucket(): string {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error('Missing env: S3_BUCKET');
  return b;
}

function guessContentType(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith('.mp4')) return 'audio/mp4';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  return 'application/octet-stream';
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
  } catch {}
  return 'job_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

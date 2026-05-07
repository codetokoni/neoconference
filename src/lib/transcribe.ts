// src/lib/transcribe.ts
//
// Transcription provider abstraction. Pluggable so we can swap between
// LiveKit Transcription (built-in), OpenAI Whisper, Deepgram, or AssemblyAI
// without touching call sites.
//
// Today this is a STUB scaffolding: the route accepts a job, returns a
// queued id, and persists a 'transcript' RecordingArtifact placeholder on
// the matching NeoEvent. Wiring to a real provider lands in a follow-up
// when TRANSCRIBE_PROVIDER + API key env vars are populated.

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
 * Returns the configured provider, or 'stub' when none is set.
 * The stub provider returns 'queued' status forever - useful for
 * UI scaffolding before any real provider is wired up.
 */
export function getTranscribeProvider(): TranscribeProvider {
  const v = (process.env.TRANSCRIBE_PROVIDER || '').toLowerCase();
  if (v === 'livekit' || v === 'openai' || v === 'deepgram' || v === 'assemblyai') {
    return v;
  }
  return 'stub';
}

export function isTranscribeConfigured(): boolean {
  return getTranscribeProvider() !== 'stub';
}

/**
 * Submit a transcription job. Today returns a queued job placeholder; a
 * follow-up commit will dispatch to the real provider when configured.
 */
export async function submitTranscribeJob(input: {
  recordingKey: string;
  eventSlug?: string;
  language?: string;
}): Promise<TranscribeJob> {
  const provider = getTranscribeProvider();
  const now = new Date().toISOString();
  const job: TranscribeJob = {
    id: cryptoRandomId(),
    recordingKey: input.recordingKey,
    eventSlug: input.eventSlug,
    language: input.language,
    provider,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };

  // TODO(provider-impl): when provider !== 'stub', dispatch to the
  // configured provider and persist returned job id. For now we
  // return the placeholder so callers can wire UI without errors.
  return job;
}

/**
 * Look up a job by id. Always returns null in stub mode.
 */
export async function getTranscribeJob(_id: string): Promise<TranscribeJob | null> {
  // TODO(persistence): persist jobs in KV keyed by id and rehydrate here.
  return null;
}

function cryptoRandomId(): string {
  // Use Web Crypto when available (edge / modern node), fall back to Math.random.
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

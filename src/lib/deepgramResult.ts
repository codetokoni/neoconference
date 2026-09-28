// src/lib/deepgramResult.ts
//
// The parts of the Deepgram round trip that do not touch the network, kept
// apart from transcribe.ts (which imports R2) so they can be unit-tested.
//
// A job used to run inside the request that submitted it: the whole
// recording read into memory, uploaded, and the request held open until
// the transcript came back. A long meeting outlasted the function and the
// job stayed "queued" for good. Now the upload streams and Deepgram posts
// the result to /api/transcribe/deepgram later; that callback is how a
// job reaches done or error. The callback URL carries an HMAC of the job
// id so only Deepgram, which was handed the URL, can finish a job.

import { createHmac, timingSafeEqual } from 'crypto';
import type { TranscribeJob, TranscriptSegment } from '@/lib/transcribe';

type DGAlt = { transcript?: string };
type DGChannel = { alternatives?: DGAlt[]; detected_language?: string; language_confidence?: number };
type DGSummary = { short?: string; result?: string };
type DGUtterance = { start?: number; end?: number; speaker?: number | string; transcript?: string };
type DGResults = { channels?: DGChannel[]; summary?: DGSummary; utterances?: DGUtterance[] };
type DGWarning = { parameter?: string; type?: string; message?: string };
export type DeepgramResponse = {
  results?: DGResults;
  metadata?: { request_id?: string; duration?: number; warnings?: DGWarning[] };
  request_id?: string;
  err_code?: string;
  err_msg?: string;
};

/** A job finished from a Deepgram response body, sync or callback. */
export function jobFromDeepgram(
  job: TranscribeJob,
  body: DeepgramResponse,
  now: string = new Date().toISOString()
): TranscribeJob {
  const externalId = body.metadata?.request_id || body.request_id || job.externalId;
  if (body.err_code || body.err_msg) {
    return {
      ...job,
      status: 'error',
      externalId,
      error: 'Deepgram: ' + (body.err_msg || body.err_code),
      updatedAt: now,
    };
  }
  const transcript = body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  const summary = body.results?.summary?.short || body.results?.summary?.result;

  // Deepgram returns start/end in seconds. Preserve to millisecond precision.
  const segments: TranscriptSegment[] = (body.results?.utterances || [])
    .filter((u) => typeof u.transcript === 'string' && u.transcript.trim().length > 0)
    .map((u) => ({
      startMs: Math.round((typeof u.start === 'number' ? u.start : 0) * 1000),
      endMs: Math.round((typeof u.end === 'number' ? u.end : 0) * 1000),
      text: (u.transcript || '').trim(),
      speaker: typeof u.speaker === 'number' || typeof u.speaker === 'string' ? u.speaker : undefined,
    }));

  if (!transcript) {
    return {
      ...job,
      status: 'error',
      externalId,
      error: emptyTranscriptMessage(body),
      updatedAt: now,
    };
  }
  return {
    ...job,
    status: 'done',
    text: transcript,
    segments: segments.length > 0 ? segments : undefined,
    summary: summary || undefined,
    externalId,
    error: undefined,
    updatedAt: now,
  };
}

/**
 * Why a transcript came back empty, from what Deepgram says it heard.
 *
 * It used to say "silent audio?" every time. A recording of someone
 * speaking was not silent — 12 seconds of speech at a normal level — and
 * that guess sent the search the wrong way. Deepgram reports how long the
 * audio was, which language it detected and any warnings; say those.
 */
export function emptyTranscriptMessage(body: DeepgramResponse): string {
  const seconds = body.metadata?.duration;
  const channel = body.results?.channels?.[0];
  const warnings = (body.metadata?.warnings || [])
    .map((w) => w.message || w.type)
    .filter((m): m is string => Boolean(m));
  if (typeof seconds === 'number' && seconds < 1) {
    return 'Deepgram received no audio (' + seconds.toFixed(1) + ' s): the recording may be empty.';
  }
  let heard = typeof seconds === 'number' ? 'Deepgram heard ' + Math.round(seconds) + ' s of audio' : 'Deepgram heard the audio';
  // Under 30% it is not naming a language, it is failing to find speech:
  // a real near-silent minute came back "English, 0% sure".
  if (typeof channel?.language_confidence === 'number' && channel.language_confidence < 0.3) {
    heard += ' but no speech it could make out. Was the microphone on and near the speaker?';
    return warnings.length > 0 ? heard + ' Deepgram said: ' + warnings.join('; ') : heard;
  }
  if (channel?.detected_language) {
    heard += ' (language detected: ' + languageName(channel.detected_language);
    if (typeof channel.language_confidence === 'number') {
      heard += ', ' + Math.round(channel.language_confidence * 100) + '% sure';
    }
    heard += ')';
  }
  heard += ' but found no words in it.';
  return warnings.length > 0 ? heard + ' Deepgram said: ' + warnings.join('; ') : heard;
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

export function callbackSignature(jobId: string, secret: string): string {
  return createHmac('sha256', secret).update('deepgram-callback:' + jobId).digest('hex');
}

export function callbackSignatureOk(jobId: string, sig: string, secret: string): boolean {
  if (!jobId || !sig || !secret) return false;
  const want = Buffer.from(callbackSignature(jobId, secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function callbackUrl(base: string, jobId: string, secret: string): string {
  return (
    base.replace(/\/+$/, '') +
    '/api/transcribe/deepgram?job=' +
    encodeURIComponent(jobId) +
    '&sig=' +
    callbackSignature(jobId, secret)
  );
}

/**
 * The audio-only sidecar egress writes beside a recording, in the order to
 * try. Audio is a fraction of the video's size and is all Deepgram needs.
 * Older runs wrote a bare .m4a; LiveKit now appends .mp4.
 */
export function audioSidecarKeys(recordingKey: string): string[] {
  if (/\.m4a(?:\.mp4)?$/i.test(recordingKey)) return [];
  if (!/\.mp4$/i.test(recordingKey)) return [];
  const base = recordingKey.slice(0, -4);
  return [base + '.m4a.mp4', base + '.m4a'];
}

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
type DGChannel = { alternatives?: DGAlt[] };
type DGSummary = { short?: string; result?: string };
type DGUtterance = { start?: number; end?: number; speaker?: number | string; transcript?: string };
type DGResults = { channels?: DGChannel[]; summary?: DGSummary; utterances?: DGUtterance[] };
export type DeepgramResponse = {
  results?: DGResults;
  metadata?: { request_id?: string };
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
      error: 'Deepgram returned empty transcript (silent audio?)',
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

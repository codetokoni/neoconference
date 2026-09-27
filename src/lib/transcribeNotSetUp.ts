// src/lib/transcribeNotSetUp.ts
//
// What to tell people when a transcription job will never finish.
//
// A job that stays 'queued' shows "✓ Queued" on the recordings page with
// the button disabled, for good. Two ways to get one: no provider key
// (a 'stub' job; /api/transcribe now refuses up front instead), or a real
// job whose function was stopped before it saved the result. Jobs stored
// either way are reported as what they are. Kept free of provider imports
// so it can be unit-tested.

export const TRANSCRIBE_NOT_SET_UP =
  "Transcription isn't set up on this server yet, so nothing was sent. " +
  'Once a transcription provider key is added, press Transcribe again.';

export const TRANSCRIBE_DID_NOT_FINISH =
  "This transcription didn't finish — the server stopped before the " +
  'result came back, which happens with long recordings. Press Transcribe to try again.';

/**
 * How long a job may stay queued or running before it cannot still be in
 * progress. Jobs run inside the request that submitted them, and a
 * function is stopped after 300 s; a job saved as queued and never updated
 * past this was killed mid-run. The hsmanagers recording (227 MB) sat
 * "queued · deepgram" for three weeks that way.
 */
export const STALE_JOB_MS = 15 * 60 * 1000;

/**
 * A stored job as it should be reported. Nothing is written back.
 *
 * - A stub job still marked queued never ran and never will.
 * - Any other job still queued or running long after its last update was
 *   stopped partway.
 *
 * Both read as errors, so the Transcribe button is offered again.
 */
export function asReported<
  T extends { provider: string; status: string; error?: string; updatedAt?: string }
>(job: T, now: number = Date.now()): T {
  if (job.provider === 'stub' && job.status === 'queued') {
    return { ...job, status: 'error', error: TRANSCRIBE_NOT_SET_UP };
  }
  if (job.status === 'queued' || job.status === 'running') {
    const at = Date.parse(job.updatedAt || '');
    if (Number.isFinite(at) && now - at > STALE_JOB_MS) {
      return { ...job, status: 'error', error: TRANSCRIBE_DID_NOT_FINISH };
    }
  }
  return job;
}

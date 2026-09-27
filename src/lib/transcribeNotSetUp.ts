// src/lib/transcribeNotSetUp.ts
//
// What to tell people when transcription has no provider.
//
// Without a provider key, submitTranscribeJob stored a job with provider
// 'stub' and status 'queued' and never touched it again, and the
// recordings page showed "✓ Queued" with the button disabled — a
// recording in production sat "queued" for three weeks. /api/transcribe
// now refuses up front instead, and jobs stored that way are reported as
// what they are: never run. Kept free of provider imports so it can be
// unit-tested.

export const TRANSCRIBE_NOT_SET_UP =
  "Transcription isn't set up on this server yet, so nothing was sent. " +
  'Once a transcription provider key is added, press Transcribe again.';

/**
 * A stored job as it should be reported. A stub job still marked queued
 * never ran and never will; it reads as an error so the Transcribe button
 * is offered again. Nothing is written back.
 */
export function asReported<T extends { provider: string; status: string; error?: string }>(
  job: T
): T {
  if (job.provider === 'stub' && job.status === 'queued') {
    return { ...job, status: 'error', error: TRANSCRIBE_NOT_SET_UP };
  }
  return job;
}

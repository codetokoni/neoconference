// src/app/api/transcribe/deepgram/route.ts
//
// POST /api/transcribe/deepgram?job=<jobId>&sig=<hmac>
//
// Where Deepgram posts a finished transcript. runDeepgram hands Deepgram
// this URL with the job id signed (deepgramResult.ts), streams it the
// audio, and returns while Deepgram works; this finishes the job. Public
// in the middleware because Deepgram has no session — the signature is
// the credential.
//
// Deepgram retries a callback that does not answer 2xx, so a job that is
// already finished is acknowledged and left alone.

import { NextRequest, NextResponse } from 'next/server';
import { transcribeStore } from '@/lib/transcribeStore';
import { callbackSignatureOk, jobFromDeepgram, type DeepgramResponse } from '@/lib/deepgramResult';
import { attachTranscriptToEvent } from '@/lib/transcriptArtifact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('job') || '';
  const sig = req.nextUrl.searchParams.get('sig') || '';
  const secret = process.env.DEEPGRAM_API_KEY || '';
  if (!callbackSignatureOk(jobId, sig, secret)) {
    return NextResponse.json({ ok: false, error: 'bad_signature' }, { status: 401 });
  }

  const job = await transcribeStore.get(jobId);
  if (!job) return NextResponse.json({ ok: true, ignored: 'unknown_job' });
  if (job.status === 'done' || job.status === 'error') {
    return NextResponse.json({ ok: true, ignored: 'already_' + job.status });
  }

  let body: DeepgramResponse;
  try {
    body = (await req.json()) as DeepgramResponse;
  } catch {
    body = { err_msg: 'callback body was not JSON' };
  }

  const finished = jobFromDeepgram(job, body);
  await transcribeStore.put(finished);
  await attachTranscriptToEvent(finished);
  // eslint-disable-next-line no-console
  console.info('[transcribe] deepgram callback', {
    jobId,
    status: finished.status,
    chars: finished.text?.length ?? 0,
    error: finished.error,
  });
  return NextResponse.json({ ok: true, status: finished.status });
}

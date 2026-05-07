// src/app/api/transcribe/route.ts
//
// POST /api/transcribe
// Body: { recordingKey: string; eventSlug?: string; language?: string }
//
// Submits an async transcription job. In stub mode (no provider env var
// configured) the job stays 'queued' forever - useful for UI scaffolding.
// Once TRANSCRIBE_PROVIDER + provider key are set, this dispatches to the
// real provider and persists the job id for later polling.
//
// GET /api/transcribe?id=<jobId>
// Returns the current status of a previously submitted job.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import {
  submitTranscribeJob,
  getTranscribeJob,
  getTranscribeProvider,
  isTranscribeConfigured,
} from '@/lib/transcribe';

export const runtime = 'nodejs';

type Body = {
  recordingKey?: string;
  eventSlug?: string;
  language?: string;
};

export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const recordingKey = (body.recordingKey || '').trim();
  if (!recordingKey) {
    return NextResponse.json(
      { ok: false, error: 'recordingKey required' },
      { status: 400 }
    );
  }

  try {
    const job = await submitTranscribeJob({
      recordingKey,
      eventSlug: body.eventSlug,
      language: body.language,
    });

    return NextResponse.json({
      ok: true,
      configured: isTranscribeConfigured(),
      provider: getTranscribeProvider(),
      job,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : 'transcribe failed',
      },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const { userId } = auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get('id') || '';
  if (!id) {
    return NextResponse.json(
      { ok: false, error: 'id query param required' },
      { status: 400 }
    );
  }

  const job = await getTranscribeJob(id);
  if (!job) {
    return NextResponse.json(
      {
        ok: false,
        configured: isTranscribeConfigured(),
        provider: getTranscribeProvider(),
        error: 'Job not found (stub mode does not persist jobs)',
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    configured: isTranscribeConfigured(),
    provider: getTranscribeProvider(),
    job,
  });
}

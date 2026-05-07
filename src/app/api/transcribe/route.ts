// src/app/api/transcribe/route.ts
//
// POST /api/transcribe
// Body: { recordingKey: string; eventSlug?: string; language?: string }
//
// Submits an async transcription job. In stub mode (no provider env var
// configured) the job stays 'queued' forever - useful for UI scaffolding.
// Once TRANSCRIBE_PROVIDER + provider key are set, this dispatches to the
// real provider, persists the job in transcribeStore, and (when the job
// resolves to 'done' with an eventSlug) appends a transcript artifact onto
// the matching NeoEvent so the replay page can render it.
//
// GET /api/transcribe?id=<jobId>
// Returns the current status of a previously submitted job (from transcribeStore).

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import {
  submitTranscribeJob,
  getTranscribeJob,
  getTranscribeProvider,
  isTranscribeConfigured,
} from '@/lib/transcribe';
import { eventStore } from '@/lib/eventStore';
import type { NeoEvent, RecordingArtifact } from '@/types/event';

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

    // If the provider returned a finished transcript and the job was tied
    // to an event, persist the transcript onto the event so /e/<slug>/replay
    // can render it without a separate poll.
    if (job.status === 'done' && job.text && job.eventSlug) {
      try {
        const ev = await eventStore.bySlug(job.eventSlug);
        if (ev) {
          const artifact: RecordingArtifact = {
            key: 'transcript:' + job.id,
            kind: 'transcript',
            label: job.text,
            createdAt: job.updatedAt,
            size: job.text.length,
          };
          await eventStore.update(ev.id, (prev: NeoEvent) => ({
            ...prev,
            recordings: [...(prev.recordings || []), artifact],
            updatedAt: new Date().toISOString(),
          }));
        }
      } catch (e) {
        // Transcript persistence is best-effort; the job result is still returned.
        // eslint-disable-next-line no-console
        console.warn('[transcribe] failed to attach transcript to event', e);
      }
    }

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
        error: 'Job not found',
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

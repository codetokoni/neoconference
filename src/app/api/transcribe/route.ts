// src/app/api/transcribe/route.ts
//
// POST /api/transcribe
// Body: { recordingKey: string; eventSlug?: string; language?: string }
//
// Submits an async transcription job. With no provider configured it
// refuses with 503 transcribe_not_configured (see transcribeNotSetUp.ts);
// it used to store a job that stayed 'queued' forever, which the
// recordings page showed as success.
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
import { authorize } from '@/lib/authz';
import { getPlanForUserId } from '@/lib/plan';
import { featureDecision, featureRefusal } from '@/lib/platform/features';
import { asReported, TRANSCRIBE_NOT_SET_UP } from '@/lib/transcribeNotSetUp';
import { attachTranscriptToEvent } from '@/lib/transcriptArtifact';
import { publicOrigin } from '@/lib/publicOrigin';
import { slugFromRecordingKey } from '@/lib/eventRecordings';

export const runtime = 'nodejs';

type Body = {
  recordingKey?: string;
  eventSlug?: string;
  language?: string;
};

export async function POST(req: NextRequest) {
  const { userId } = await auth();
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

  // FRS §8: generating a transcript is Owner+Host per the "transcript access
  // controlled by the Owner or Host" clause. When the caller supplies an
  // eventSlug we gate on the RBAC catalog; without one there is no event
  // context to authz against so we fall back to authenticated-only (the
  // recording key itself is scoped by userId prefix on R2).
  //
  // The recordings page sends only the key; the meeting is in its path.
  // Without it the finished transcript was never recorded on the meeting,
  // so its chapters, downloads and replay never saw it.
  const eventSlug = (body.eventSlug || '').trim() || slugFromRecordingKey(recordingKey) || '';
  // Feature controls (admin) apply to the meeting's owner, or to the caller
  // when there is no meeting.
  let billedTo = userId;
  if (eventSlug) {
    const ev = await eventStore.bySlug(eventSlug);
    if (ev) {
      const gate = await authorize(ev, 'summary:generate');
      if (!gate.ok) return gate.response;
      if (ev.ownerUserId) billedTo = ev.ownerUserId;
    }
  }
  const transcription = await featureDecision('transcription', { userId: billedTo, plan: await getPlanForUserId(billedTo) });
  if (!transcription.enabled) return featureRefusal(transcription);

  if (!isTranscribeConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'transcribe_not_configured', message: TRANSCRIBE_NOT_SET_UP },
      { status: 503 }
    );
  }

  try {
    const job = await submitTranscribeJob({
      recordingKey,
      eventSlug: eventSlug || undefined,
      language: body.language,
      callbackUrlBase: publicOrigin(req),
    });

    // Finished inline (a provider without a callback): record it on the
    // event now. Deepgram's callback does the same when it arrives.
    await attachTranscriptToEvent(job);

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
  const { userId } = await auth();
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

  const stored = await getTranscribeJob(id);
  const job = stored ? asReported(stored) : null;
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

  // FRS §8.7: transcript access controlled by Owner+Host. Gate on the RBAC
  // catalog when the job is tied to an event; older jobs without eventSlug
  // fall back to authenticated-only (the recording key is scoped by userId
  // prefix, so a caller can only see their own).
  if (job.eventSlug) {
    const ev = await eventStore.bySlug(job.eventSlug);
    if (ev) {
      const gate = await authorize(ev, 'transcript:read');
      if (!gate.ok) return gate.response;
    }
  }

  return NextResponse.json({
    ok: true,
    configured: isTranscribeConfigured(),
    provider: getTranscribeProvider(),
    job,
  });
}

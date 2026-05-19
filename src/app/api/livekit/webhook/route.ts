// src/app/api/livekit/webhook/route.ts
//
// LiveKit webhook handler. Configure this URL in your LiveKit Cloud project
// settings (Webhooks tab) — it must point to:
//   https://www.neoconference.app/api/livekit/webhook
//
// Subscribed events:
//   - egress_ended    -> auto-submit transcription job
//   - room_started    -> set NeoEvent.startedAt if unset (idempotent)
//   - room_finished   -> transition NeoEvent.state 'live' -> 'ended' with
//                        endedAt from webhook timestamp (idempotent)
//
// Signature verification is handled by livekit-server-sdk's WebhookReceiver,
// which validates the Authorization header against the project's API secret.
// On signature mismatch we return 200 OK rather than 401 so LiveKit doesn't
// retry endlessly during transient misconfigurations.

import { NextResponse } from 'next/server';
import { WebhookReceiver } from 'livekit-server-sdk';
import { submitTranscribeJob, isTranscribeConfigured } from '@/lib/transcribe';
import { eventStore } from '@/lib/eventStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error('Missing env: ' + name);
  return v;
}

/**
 * LiveKit emits unix seconds in `createdAt`. Some SDK builds vary; defensively
 * handle either seconds or milliseconds. Falls back to now on invalid input.
 */
function isoFromWebhookCreatedAt(createdAt: unknown): string {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return new Date().toISOString();
  }
  const ms = createdAt > 1e11 ? createdAt : createdAt * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

export async function POST(req: Request) {
  try {
    const apiKey = requiredEnv('LIVEKIT_API_KEY');
    const apiSecret = requiredEnv('LIVEKIT_API_SECRET');
    const receiver = new WebhookReceiver(apiKey, apiSecret);

    // LiveKit signs the raw request body. We must pass it as a string along
    // with the Authorization header (which contains the signature JWT).
    const body = await req.text();
    const authHeader = req.headers.get('Authorization') || '';

    type LKEgressInfo = {
      egressId?: string;
      roomId?: string;
      roomName?: string;
      status?: number | string;
      file?: { filename?: string; location?: string };
      fileResults?: Array<{ filename?: string; location?: string }>;
    };
    type LKWebhookEvent = {
      event?: string;
      egressInfo?: LKEgressInfo;
      room?: { name?: string };
      createdAt?: number;
    };

    const event = (await receiver.receive(body, authHeader)) as unknown as LKWebhookEvent;

    // ----- room_finished: transition NeoEvent state 'live' -> 'ended' -----
    if (event?.event === 'room_finished') {
      const roomName = event.room?.name;
      if (!roomName) {
        return NextResponse.json({ ok: true, ignored: 'room_finished_no_room' });
      }
      const ev = await eventStore.bySlug(roomName);
      if (!ev) {
        return NextResponse.json({ ok: true, ignored: 'event_not_found', roomName });
      }
      if (ev.state !== 'live') {
        return NextResponse.json({ ok: true, transitioned: false, reason: 'not_live', eventId: ev.id });
      }
      const endedAt = isoFromWebhookCreatedAt(event.createdAt);
      await eventStore.update(ev.id, (prev) => ({
        ...prev,
        state: 'ended',
        endedAt: prev.endedAt || endedAt,
        updatedAt: new Date().toISOString(),
      }));
      return NextResponse.json({ ok: true, transitioned: true, eventId: ev.id, endedAt });
    }

    // ----- room_started: set startedAt if it isn't already set -----
    if (event?.event === 'room_started') {
      const roomName = event.room?.name;
      if (!roomName) {
        return NextResponse.json({ ok: true, ignored: 'room_started_no_room' });
      }
      const ev = await eventStore.bySlug(roomName);
      if (!ev) {
        return NextResponse.json({ ok: true, ignored: 'event_not_found', roomName });
      }
      if (ev.startedAt) {
        return NextResponse.json({ ok: true, transitioned: false, reason: 'already_started', eventId: ev.id });
      }
      const startedAt = isoFromWebhookCreatedAt(event.createdAt);
      await eventStore.update(ev.id, (prev) => ({
        ...prev,
        startedAt: prev.startedAt || startedAt,
        updatedAt: new Date().toISOString(),
      }));
      return NextResponse.json({ ok: true, transitioned: true, eventId: ev.id, startedAt });
    }

    // We only auto-transcribe when a recording egress finished writing.
    if (event?.event !== 'egress_ended') {
      return NextResponse.json({ ok: true, ignored: event?.event || 'unknown' });
    }

    // Extract the R2 key that egress wrote to. LiveKit gives us either a
    // single file or an array depending on egress type.
    const egressInfo = event.egressInfo;
    const fileFromInfo = egressInfo?.file?.filename;
    const fileFromResults = egressInfo?.fileResults?.[0]?.filename;
    const filename = fileFromInfo || fileFromResults || '';
    if (!filename) {
      return NextResponse.json({ ok: true, skipped: 'no file path on egress' });
    }

    // Each recording produces two egress_ended events: one for the .mp4
    // video and one for the .ogg audio sidecar. Only transcribe off the
    // video file so we don't queue a duplicate Deepgram job per recording.
    if (!filename.toLowerCase().endsWith('.mp4')) {
      return NextResponse.json({ ok: true, skipped: 'audio_sidecar', filename });
    }

    // egress writes 'recordings/user_xxx/event-slug/timestamp.mp4'. We pass
    // the full key as the recordingKey. Try to extract the event slug from
    // the path so we can later attach the transcript to the event.
    const parts = filename.split('/');
    // parts: ['recordings', 'user_xxx', 'event-slug', 'timestamp.mp4']
    const eventSlug = parts.length >= 4 ? parts[2] : undefined;

    if (!isTranscribeConfigured()) {
      // Provider is in stub mode — webhook is still 200, we just don't run.
      return NextResponse.json({
        ok: true,
        skipped: 'transcribe provider not configured',
        filename,
      });
    }

    // Kick the transcribe job. submitTranscribeJob blocks until Deepgram
    // returns (Nova-3 is fast: <30 s for a typical meeting). LiveKit's
    // webhook delivery timeout is 30 s; for longer recordings we'd switch
    // to a fire-and-forget pattern with a status row in KV. For now, await.
    const job = await submitTranscribeJob({
      recordingKey: filename,
      eventSlug,
    });

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      status: job.status,
      filename,
      eventSlug,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Always return 200 on signature mismatch / bad payload so LiveKit doesn't
    // retry endlessly; surface the error in the response body for debugging.
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}

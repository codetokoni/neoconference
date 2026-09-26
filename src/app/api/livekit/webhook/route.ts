// src/app/api/livekit/webhook/route.ts
//
// LiveKit webhook handler. Configure this URL in your LiveKit Cloud project
// settings (Webhooks tab) — it must point to:
//   https://www.neoconference.app/api/livekit/webhook
//
// Subscribed events:
//   - egress_ended    -> auto-submit transcription job
//   - room_started    -> set NeoEvent.startedAt if unset (idempotent)
//   - room_finished   -> transition an in-progress NeoEvent ('live' or
//                        'waiting') to 'ended' with
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
import { recordAttendance } from '@/lib/attendance';
import { recordWebhookEvent, recordWebhookRejection } from '@/lib/webhookMetrics';
import {
  canEnd,
  endsWhenRoomFinishes,
  goesLiveWhenRoomStarts,
} from '@/lib/meetingLifecycle';
import { clearedForNewSession } from '@/lib/waitingRoom';

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
    type LKParticipant = {
      identity?: string;
      name?: string;
      metadata?: string;
    };
    type LKWebhookEvent = {
      event?: string;
      egressInfo?: LKEgressInfo;
      room?: { name?: string };
      participant?: LKParticipant;
      createdAt?: number;
    };

    const event = (await receiver.receive(body, authHeader)) as unknown as LKWebhookEvent;

    // Telemetry: bump per-event counters so /api/admin/verify-webhooks can
    // report which subscriptions are actually landing. Fire-and-forget.
    if (event?.event) {
      void recordWebhookEvent(event.event);
    }

    // ----- participant_joined / participant_left: attendance capture (§4) --
    if (event?.event === 'participant_joined' || event?.event === 'participant_left') {
      const roomName = event.room?.name;
      const participant = event.participant;
      if (!roomName || !participant?.identity) {
        return NextResponse.json({ ok: true, ignored: 'participant_event_missing_fields' });
      }
      const ev = await eventStore.bySlug(roomName);
      if (!ev) {
        return NextResponse.json({ ok: true, ignored: 'event_not_found', roomName });
      }
      let role = '';
      try {
        const md = participant.metadata ? JSON.parse(participant.metadata) : null;
        if (md && typeof (md as { role?: unknown }).role === 'string') {
          role = (md as { role: string }).role;
        }
      } catch {
        // metadata is optional
      }
      const ts = Date.parse(isoFromWebhookCreatedAt(event.createdAt));
      const baseIdentity = participant.identity.split('#')[0];
      await recordAttendance(ev.id, {
        ts: Number.isFinite(ts) ? ts : Date.now(),
        action: event.event === 'participant_joined' ? 'join' : 'leave',
        userId: baseIdentity || null,
        name: participant.name || baseIdentity || '',
        role,
        source: 'webhook',
      });
      return NextResponse.json({ ok: true, recorded: event.event, eventId: ev.id });
    }

    // ----- room_finished: transition NeoEvent state 'live' -> 'ended' -----
    if (event?.event === 'room_finished') {
      // Every outcome below that does not end a meeting is written down.
      // room_finished had fired 224 times with 7 rooms still open and no
      // record of which 7 or why; the counters only say an event arrived,
      // because they are bumped before the handler runs.
      const roomName = event.room?.name;
      if (!roomName) {
        await recordWebhookRejection({
          event: 'room_finished',
          room: '',
          reason: 'no_room',
        });
        return NextResponse.json({ ok: true, ignored: 'room_finished_no_room' });
      }
      const ev = await eventStore.bySlug(roomName);
      if (!ev) {
        await recordWebhookRejection({
          event: 'room_finished',
          room: roomName,
          reason: 'event_not_found',
        });
        return NextResponse.json({ ok: true, ignored: 'event_not_found', roomName });
      }
      // The room emptied: this session's admissions and refusals end with
      // it, for every room including always-open ones. Before, a person
      // admitted once skipped that room's waiting room for good, and one
      // refused once could never knock again. Done first, because every
      // branch below returns.
      const cleared = clearedForNewSession(ev);
      if (cleared) {
        await eventStore.update(ev.id, (prev) => ({
          ...prev,
          ...(clearedForNewSession(prev) ?? {}),
        }));
        console.info('[webhook] waiting room reset', roomName);
      }
      // An always-open room emptying is not a meeting ending. Marking it
      // 'ended' here, every time the last person left, is what made its
      // owner rejoin as an attendee.
      if (!canEnd(ev)) {
        await recordWebhookRejection({
          event: 'room_finished',
          room: roomName,
          reason: 'permanent_room',
          state: ev.state,
          eventId: ev.id,
        });
        return NextResponse.json({
          ok: true,
          transitioned: false,
          reason: 'permanent_room',
          eventId: ev.id,
        });
      }
      // 'waiting' counts as open, not just 'live'. Checking only for
      // 'live' meant a meeting whose attendees were still in the waiting
      // room when the room closed could never be ended by this webhook at
      // all — it sat open until someone noticed months later. So does a
      // 'scheduled' one whose time has come (see endsWhenRoomFinishes).
      if (!endsWhenRoomFinishes(ev, Date.now())) {
        await recordWebhookRejection({
          event: 'room_finished',
          room: roomName,
          reason: 'not_in_progress',
          state: ev.state,
          eventId: ev.id,
        });
        return NextResponse.json({
          ok: true,
          transitioned: false,
          reason: 'not_in_progress',
          state: ev.state,
          eventId: ev.id,
        });
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

    // ----- room_started: set startedAt, and a due meeting is now live -----
    if (event?.event === 'room_started') {
      const roomName = event.room?.name;
      if (!roomName) {
        return NextResponse.json({ ok: true, ignored: 'room_started_no_room' });
      }
      const ev = await eventStore.bySlug(roomName);
      if (!ev) {
        return NextResponse.json({ ok: true, ignored: 'event_not_found', roomName });
      }
      const now = Date.now();
      const goLive = goesLiveWhenRoomStarts(ev, now);
      if (ev.startedAt && !goLive) {
        return NextResponse.json({ ok: true, transitioned: false, reason: 'already_started', eventId: ev.id });
      }
      const startedAt = isoFromWebhookCreatedAt(event.createdAt);
      await eventStore.update(ev.id, (prev) => ({
        ...prev,
        // Re-checked on the stored copy: another writer may have moved it.
        state: goesLiveWhenRoomStarts(prev, now) ? ('live' as const) : prev.state,
        startedAt: prev.startedAt || startedAt,
        updatedAt: new Date().toISOString(),
      }));
      if (goLive) console.info('[webhook] meeting went live', roomName);
      return NextResponse.json({ ok: true, transitioned: true, live: goLive, eventId: ev.id, startedAt });
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

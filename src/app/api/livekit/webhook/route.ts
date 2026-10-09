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
import { isAudioKey, slugFromRecordingKey } from '@/lib/eventRecordings';
import { publicOrigin } from '@/lib/publicOrigin';
import { eventStore } from '@/lib/eventStore';
import { recordAttendance } from '@/lib/attendance';
import { disconnectReasonName } from '@/lib/disconnectReason';
import { addRecordedSeconds, egressSeconds } from '@/lib/recordingUsage';
import { recordingReminder } from '@/lib/comms/reminders';
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
      error?: string;
      file?: { filename?: string; location?: string };
      fileResults?: Array<{ filename?: string; location?: string }>;
    };
    type LKParticipant = {
      identity?: string;
      name?: string;
      metadata?: string;
      /** livekit.DisconnectReason on participant_left: a number, or its name in JSON form. */
      disconnectReason?: number | string;
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
      const left = event.event === 'participant_left';
      await recordAttendance(ev.id, {
        ts: Number.isFinite(ts) ? ts : Date.now(),
        action: left ? 'leave' : 'join',
        userId: baseIdentity || null,
        name: participant.name || baseIdentity || '',
        role,
        source: 'webhook',
        // Why they went, in LiveKit's words. Without it a room that
        // emptied in a minute reads the same whether everyone pressed
        // Leave or everyone's link dropped.
        ...(left ? { reason: disconnectReasonName(participant.disconnectReason) } : {}),
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
        // Emptied, not ended by anyone: rejoining keeps roles and reopens it.
        endedBy: 'room_empty' as const,
        // This close's own time. Only a meeting in progress gets here, so a
        // stored endedAt is left over from an earlier end — keeping it, as
        // `prev.endedAt || endedAt` did, recorded a restarted meeting as
        // ending hours before it did.
        endedAt,
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
      await eventStore.update(ev.id, (prev) => {
        // Re-checked on the stored copy: another writer may have moved it.
        if (!goesLiveWhenRoomStarts(prev, now)) {
          return { ...prev, startedAt: prev.startedAt || startedAt, updatedAt: new Date().toISOString() };
        }
        // Back on after emptying: its old end no longer stands. (undefined
        // is dropped when the event is stored.)
        return {
          ...prev,
          state: 'live' as const,
          startedAt: prev.startedAt || startedAt,
          endedAt: undefined,
          endedBy: undefined,
          updatedAt: new Date().toISOString(),
        };
      });
      if (goLive) console.info('[webhook] meeting went live', roomName);
      return NextResponse.json({ ok: true, transitioned: true, live: goLive, eventId: ev.id, startedAt });
    }

    // We only auto-transcribe when a recording egress finished writing.
    if (event?.event !== 'egress_ended') {
      return NextResponse.json({ ok: true, ignored: event?.event || 'unknown' });
    }

    const egressInfo = event.egressInfo;

    // A livestream that ended — stopped, the room closed, or every
    // destination failed — must stop being "live on YouTube" on the event.
    if (egressInfo?.egressId && egressInfo.roomName) {
      const ev = await eventStore.bySlug(egressInfo.roomName);
      if (ev?.livestream?.egressId === egressInfo.egressId) {
        await eventStore.update(ev.id, (prev) => ({ ...prev, livestream: undefined, updatedAt: new Date().toISOString() }));
        return NextResponse.json({ ok: true, livestream: 'ended', egressId: egressInfo.egressId, error: egressInfo.error || undefined });
      }
    }

    // Extract the R2 key that egress wrote to. LiveKit gives us either a
    // single file or an array depending on egress type.
    const fileFromInfo = egressInfo?.file?.filename;
    const fileFromResults = egressInfo?.fileResults?.[0]?.filename;
    const filename = fileFromInfo || fileFromResults || '';
    if (!filename) {
      return NextResponse.json({ ok: true, skipped: 'no file path on egress' });
    }

    // Each recording produces two egress_ended events: one for the .mp4
    // video and one for the .ogg audio sidecar. Only transcribe off the
    // video file so we don't queue a duplicate Deepgram job per recording.
    // The sidecar is named "<base>.m4a.mp4", which ends in .mp4 too, so the
    // extension alone let it through and each recording was transcribed
    // twice. (The video's job sends Deepgram that sidecar anyway.)
    if (!filename.toLowerCase().endsWith('.mp4') || isAudioKey(filename)) {
      return NextResponse.json({ ok: true, skipped: 'audio_sidecar', filename });
    }

    // egress writes 'recordings/user_xxx/event-slug/timestamp.mp4'. We pass
    // the full key as the recordingKey. Try to extract the event slug from
    // the path so we can later attach the transcript to the event.
    const eventSlug = slugFromRecordingKey(filename);

    // Count the recording's length against its owner's monthly hours
    // (lib/recordingUsage). Before transcription, which may be switched
    // off: the hours are spent either way. The slug's owner stands in for
    // recordings started before egress/start remembered whose they were.
    let usage: Awaited<ReturnType<typeof addRecordedSeconds>> | undefined;
    try {
      const fallbackOwner = eventSlug
        ? (await eventStore.bySlug(eventSlug))?.ownerUserId
        : undefined;
      usage = await addRecordedSeconds(
        egressInfo?.egressId || '',
        egressSeconds(egressInfo as Parameters<typeof egressSeconds>[0]),
        Date.now(),
        fallbackOwner
      );
      if (!usage.counted) console.warn('[webhook] recording not counted:', usage.reason, filename);
      else if (usage.owner) await recordingReminder(usage.owner);
    } catch (err) {
      console.warn('[webhook] recording usage failed', err);
    }

    if (!isTranscribeConfigured()) {
      // Provider is in stub mode — webhook is still 200, we just don't run.
      return NextResponse.json({
        ok: true,
        skipped: 'transcribe provider not configured',
        filename,
        usage,
      });
    }

    // Kick the transcribe job. With a callback origin this returns once
    // the audio is uploaded; Deepgram posts the transcript to
    // /api/transcribe/deepgram when it is done.
    const job = await submitTranscribeJob({
      recordingKey: filename,
      eventSlug,
      callbackUrlBase: publicOrigin(req),
    });

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      status: job.status,
      filename,
      eventSlug,
      usage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Always return 200 on signature mismatch / bad payload so LiveKit doesn't
    // retry endlessly; surface the error in the response body for debugging.
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}

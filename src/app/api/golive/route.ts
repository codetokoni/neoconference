import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createStream, isStreamLabConfigured } from '@/lib/streamlab';
import { eventStore } from '@/lib/eventStore';
import { authorize } from '@/lib/authz';
import { getPlanForUserId, getPlanLimits } from '@/lib/plan';

export const runtime = 'nodejs';

/**
 * POST /api/golive
 *
 * Provisions an ad-hoc StreamLab broadcast bound to a room.
 * Returns RTMP ingest credentials + HLS playback URL.
 *
 * Body: {
 *   roomName: string,
 *   title?: string,
 *   eventSlug?: string  // when provided, persists the broadcast
 *                       // to the matching event and flips state to 'live'
 * }
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  if (!isStreamLabConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'StreamLab is not configured. Set STREAMLAB_API_KEY in environment.' },
      { status: 503 }
    );
  }

  let body: { roomName?: string; title?: string; eventSlug?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const roomName = (body.roomName || '').trim();
  if (!roomName) {
    return NextResponse.json({ ok: false, error: 'roomName required' }, { status: 400 });
  }

  const name = (body.title || roomName).slice(0, 80);
  const eventSlug = (body.eventSlug || '').trim() || null;

  // ---- Authz (F-3) ----
  // Going live writes state, startedAt and fresh stream credentials onto the
  // event record, so it needs the same standing as starting the meeting. The
  // slug is resolved before StreamLab is called: no provisioning happens for a
  // caller who is about to be refused.
  const targetSlug = eventSlug || roomName;
  const targetEvent = await eventStore.bySlug(targetSlug);
  if (!targetEvent) {
    return NextResponse.json({ ok: false, error: 'event_not_found' }, { status: 404 });
  }
  const gate = await authorize(targetEvent, 'stream:golive');
  if (!gate.ok) return gate.response;

  // Plan gate — livestream is Enterprise-only. Checked AFTER the role
  // authz gate so a non-host on a paid plan gets the more accurate
  // "not authorized" error rather than a misleading upgrade prompt.
  // Plan is read from the EVENT OWNER's account (not the caller's),
  // so a host / cohost on an enterprise event can still trigger
  // Go Live without themselves being on an enterprise plan.
  try {
    const ownerPlan = await getPlanForUserId(targetEvent.ownerUserId);
    const ownerLimits = getPlanLimits(ownerPlan);
    if (!ownerLimits.livestream) {
      return NextResponse.json(
        {
          ok: false,
          error: 'plan_upgrade_required',
          hostPlan: ownerPlan,
          message:
            'Livestreaming is available on the Enterprise plan only. ' +
            'The event owner is on the ' + ownerPlan + ' plan; upgrade at /dashboard/billing to enable Go Live.',
        },
        { status: 402 } // Payment Required — the standards-conformant "you can't do this without upgrading" status
      );
    }
  } catch (planErr) {
    // A plan-lookup failure shouldn't take Go Live down for legitimate
    // enterprise customers. Log it and let the request through — the
    // StreamLab API will still fail cleanly if provisioning breaks
    // for another reason.
    console.error('[golive] plan lookup failed, allowing through:', planErr);
  }

  try {
    const stream = await createStream({ name, mode: 'single', latency: 'hls' });

    // Optional: link to an event if a slug was provided.
    let linkedEvent: { id: string; slug: string } | null = null;
    if (eventSlug) {
      const ev = targetEvent.slug === eventSlug ? targetEvent : await eventStore.bySlug(eventSlug);
      if (ev) {
        const updated = await eventStore.update(ev.id, {
          state: 'live',
          startedAt: new Date().toISOString(),
          streamlab: {
            streamId: stream.id,
            rtmpUrl: stream.rtmpUrl,
            streamKey: stream.streamKey,
            hlsUrl: stream.hlsUrl,
            playbackId: stream.playbackId,
          },
        });
        if (updated) {
          linkedEvent = { id: updated.id, slug: updated.slug };
        }
      }
    }

    return NextResponse.json({
      ok: true,
      stream: {
        id: stream.id,
        rtmpUrl: stream.rtmpUrl,
        streamKey: stream.streamKey,
        hlsUrl: stream.hlsUrl,
        playbackId: stream.playbackId,
      },
      linkedEvent,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}

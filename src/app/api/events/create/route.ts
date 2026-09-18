// src/app/api/events/create/route.ts
// One-call event provisioning: builds the LiveKit room name, optional StreamLab
// stream, optional HSMOH shortlink, and persists the NeoEvent to KV.
//
// Free-tier lifetime cap: this is one of three meeting-creation entry points
// gated by checkLifetimeCap() / incrementMeetingsCreated() from @/lib/plan.
// The others are /api/events/instant and the adoptOrphanRoom path inside
// /api/livekit/token.

import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore, generateId, generateSlug, generateQrSeed } from '@/lib/eventStore';
import { streamlab } from '@/lib/streamlab';
import { hsmoh } from '@/lib/hsmoh';
import { checkLifetimeCap, incrementMeetingsCreated, getPlanForUserId, getPlanLimits } from '@/lib/plan';
import { hashMeetingPassword } from '@/lib/eventPassword';
import type { NeoEvent, RoleAssignment } from '@/types/event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateBody {
    name: string;
    description?: string;
    visibility?: 'public' | 'unlisted' | 'private';
    password?: string;
    waitingRoomEnabled?: boolean;
    waitForHost?: boolean;
    scheduledAt?: string;
    roles?: RoleAssignment[];
    enableStream?: boolean;
    enableShortlink?: boolean;
}

function originFrom(req: NextRequest): string {
    const env = process.env.NEXT_PUBLIC_SITE_URL;
    if (env) return env.replace(/\/+$/, '');
    const proto = req.headers.get('x-forwarded-proto') ?? 'https';
    const host = req.headers.get('host') ?? 'localhost:3000';
    return proto + '://' + host;
}

export async function POST(req: NextRequest) {
    const { userId } = await auth();
    if (!userId) {
          return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }

  // Free-tier lifetime cap gate. Blocks Free users who have already created
  // their lifetime allotment of meetings. Paid plans return blocked=false.
  const cap = await checkLifetimeCap(userId);
    if (cap.blocked) {
          return NextResponse.json(
            {
                      error: 'lifetime_meetings_exhausted',
                      plan: cap.plan,
                      used: cap.used,
                      cap: cap.cap,
                      message:
                                  'You have reached the Free plan limit of ' + cap.cap +
                                  ' lifetime meetings. Upgrade to create more.',
            },
            { status: 403 },
                );
    }

  // Snapshot owner email so re-logins (or future Clerk userId churn) still resolve as owner.
  let ownerEmail: string | undefined;
    try {
          const u0 = await currentUser();
          ownerEmail = u0?.emailAddresses?.find((e) => e.id === u0.primaryEmailAddressId)?.emailAddress
            || u0?.emailAddresses?.[0]?.emailAddress
            || undefined;
          if (ownerEmail) ownerEmail = ownerEmail.toLowerCase();
    } catch { /* non-fatal */ }

  let body: CreateBody;
    try {
          body = (await req.json()) as CreateBody;
    } catch {
          return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }

  const name = (body.name ?? '').trim();
    if (!name) {
          return NextResponse.json({ error: 'name_required' }, { status: 400 });
    }

  const id = generateId();
    // Pass a real collision predicate so generateSlug returns the
    // clean form when possible ("weekly-sync") and only falls back
    // to a random suffix when that clean form is taken. Callers of
    // eventStore.bySlug elsewhere agree slugs are unique across the
    // KV, so bySlug returning null is a solid "free" signal.
    const slug = await generateSlug(name, async (candidate) => {
          const existing = await eventStore.bySlug(candidate);
          return !!existing;
    });
    const livekitRoom = slug;
    const now = new Date().toISOString();

  // Plan gate for RTMP livestream provisioning. Livestream is
  // Enterprise-only (see /lib/plan.ts and #247). The in-room Go Live
  // button already enforces the same gate via /api/golive; this is
  // the second entry point that /api/events/create's Provision RTMP
  // checkbox opens, and it was missed in the original PR — allowing
  // any-plan users to still get a StreamLab stream by ticking the
  // box on the /dashboard/new form. Fixed here.
  //
  // Refuse LOUDLY (not silently) so the operator learns why the
  // stream didn't come with their event, matching the friendly error
  // shape /api/golive already returns.
  let streamlabBinding: NeoEvent['streamlab'] | undefined;
  if (body.enableStream) {
    try {
      const ownerPlan = await getPlanForUserId(userId);
      const ownerLimits = getPlanLimits(ownerPlan);
      if (!ownerLimits.livestream) {
        return NextResponse.json(
          {
            error: 'plan_upgrade_required',
            plan: ownerPlan,
            message:
              'Livestreaming is available on the Enterprise plan only. ' +
              'Upgrade at /dashboard/billing, or create the event without the ' +
              'Provision RTMP livestream option.',
          },
          { status: 402 }
        );
      }
    } catch (planErr) {
      // A plan lookup blip shouldn't take event creation down for a
      // real enterprise customer. Log and fall through — StreamLab
      // will still fail cleanly if the caller ends up unauthorised
      // downstream.
      console.error('[events/create] plan lookup failed, allowing through:', planErr);
    }

    if (streamlab.isConfigured()) {
      try {
        const s = await streamlab.createStream({ name });
        streamlabBinding = {
          streamId: s.id,
          rtmpUrl: s.rtmpUrl,
          streamKey: s.streamKey,
          hlsUrl: s.hlsUrl,
          playbackId: s.playbackId,
        };
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[events/create] streamlab.createStream failed:', e);
      }
    }
  }

  // Hand out the short URL as the canonical event link. Middleware
  // (src/middleware.ts) rewrites `neoconference.app/<slug>` to the
  // room / event page at request time, so /<slug> and /e/<slug>
  // both resolve — but the short form is what the operator sees in
  // the "Event link" field and it's what actually gets pasted into
  // WhatsApp / posters / etc. The `/e/<slug>` route stays available
  // so any bookmark or shared link from before this change still
  // opens.
  const longUrl = originFrom(req) + '/' + slug;
    let hsmohBinding: NeoEvent['hsmoh'] | undefined;
    if (body.enableShortlink !== false && hsmoh.isConfigured()) {
          try {
                  const r = await hsmoh.shortenWithFallback(longUrl, slug);
                  hsmohBinding = {
                            shortCode: r.short_code,
                            shortUrl: r.short_url,
                  };
          } catch (e) {
                  // eslint-disable-next-line no-console
            console.warn('[events/create] hsmoh.shortenWithFallback failed:', e);
          }
    }
    if (!hsmohBinding) {
          hsmohBinding = { shortCode: slug, shortUrl: longUrl, fallback: true };
    }

  const ev: NeoEvent = {
        id,
        slug,
        name,
        description: body.description,
        ownerUserId: userId,
        ownerEmail,
        visibility: body.visibility ?? 'unlisted',
        password: hashMeetingPassword((body.password || "").slice(0, 80)),
        waitingRoomEnabled: Boolean(body.waitingRoomEnabled),
        waitForHost: body.waitForHost === false ? false : true,
        scheduledAt: body.scheduledAt,
        livekitRoom,
        streamlab: streamlabBinding,
        hsmoh: hsmohBinding,
        qrSeed: generateQrSeed(),
        roles: body.roles ?? [],
        waitingRoom: [],
        recordings: [],
        state: 'scheduled',
        createdAt: now,
        updatedAt: now,
  };

  await eventStore.create(ev);

  // Seed the event with the owner's recurring-roles list (see
  // /api/user/recurring-roles). Best-effort: a seed failure logs but
  // does not undo the event creation — the owner can re-promote by
  // hand if needed.
  try {
    const { applyRecurringRoles } = await import('@/lib/recurring-roles');
    await applyRecurringRoles(ev.id, userId);
  } catch (seedErr) {
    console.warn('[events/create] recurring-roles seed failed:', seedErr);
  }

  // Increment Free-tier lifetime counter. No-op for paid plans.
  // Best-effort: failure here logs but does not undo the event creation.
  await incrementMeetingsCreated(userId);

  return NextResponse.json({
        id: ev.id,
        slug: ev.slug,
        livekitRoom: ev.livekitRoom,
        qrUrl: '/api/qr/' + ev.slug,
        eventUrl: '/' + ev.slug,
        shortUrl: ev.hsmoh?.shortUrl,
        rtmpUrl: ev.streamlab?.rtmpUrl,
        streamKey: ev.streamlab?.streamKey,
        hlsUrl: ev.streamlab?.hlsUrl,
  });
}

// src/app/api/events/instant/route.ts
// One-click instant meeting: provisions an event with state='live'
// (no scheduledAt, no waiting room) and returns its slug + livekitRoom
// so the client can navigate straight into /room/<name>?event=<slug>.
//
// POST /api/events/instant body: { name?: string } -> 201 { ok, slug, livekitRoom, eventUrl, roomUrl }
//
// Free-tier lifetime cap: this is one of three meeting-creation entry points
// gated by checkLifetimeCap() / incrementMeetingsCreated() from @/lib/plan.

import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import {
    eventStore,
    generateId,
    generateSlug,
    generateQrSeed,
} from '@/lib/eventStore';
import { hsmoh } from '@/lib/hsmoh';
import { checkLifetimeCap, incrementMeetingsCreated } from '@/lib/plan';
import type { NeoEvent } from '@/types/event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  // Free-tier lifetime cap gate.
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

  let body: { name?: string } = {};
    try { body = (await req.json()) as { name?: string }; } catch { /* empty body OK */ }

  // Default name: "<First name>'s instant meeting" or "Instant meeting"
  let name = (body.name || '').trim();
    if (!name) {
          try {
                  const u = await currentUser();
                  const first = u?.firstName || u?.username || '';
                  name = first ? `${first}'s instant meeting` : 'Instant meeting';
          } catch {
                  name = 'Instant meeting';
          }
    }

  const id = generateId();
    const slug = generateSlug(name);
    const livekitRoom = slug;
    const now = new Date().toISOString();

  // Try to mint a real shortlink. Falls back to long URL if HSMOH not configured.
  const longUrl = originFrom(req) + '/e/' + slug;
    let hsmohBinding: NeoEvent['hsmoh'] | undefined;
    if (hsmoh.isConfigured()) {
          try {
                  const r = await hsmoh.shortenWithFallback(longUrl, slug);
                  hsmohBinding = { shortCode: r.short_code, shortUrl: r.short_url };
          } catch (e) {
                  // eslint-disable-next-line no-console
            console.warn('[events/instant] hsmoh failed:', e);
          }
    }
    if (!hsmohBinding) {
          hsmohBinding = { shortCode: slug, shortUrl: longUrl, fallback: true };
    }

  const ev: NeoEvent = {
        id,
        slug,
        name,
        ownerUserId: userId,
        ownerEmail,
        visibility: 'unlisted',
        waitingRoomEnabled: false,
        livekitRoom,
        hsmoh: hsmohBinding,
        qrSeed: generateQrSeed(),
        roles: [],
        waitingRoom: [],
        recordings: [],
        state: 'live',
        startedAt: now,
        createdAt: now,
        updatedAt: now,
  };

  await eventStore.create(ev);

  // Increment Free-tier lifetime counter. No-op for paid plans.
  await incrementMeetingsCreated(userId);

  return NextResponse.json(
    {
            ok: true,
            slug: ev.slug,
            livekitRoom: ev.livekitRoom,
            eventUrl: '/e/' + ev.slug,
            roomUrl: '/room/' + ev.livekitRoom + '?event=' + ev.slug,
            shortUrl: ev.hsmoh?.shortUrl,
    },
    { status: 201 },
      );
}
  );
}

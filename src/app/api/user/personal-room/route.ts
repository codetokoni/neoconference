// src/app/api/user/personal-room/route.ts
//
// GET /api/user/personal-room
// Returns (creating on first call) the signed-in user's permanent
// personal room. One event per user, isPermanent: true. Slug is derived
// from the user's first name (or username), with a numeric suffix if
// that base collides. The event's state does not matter for a permanent
// room — middleware routes /<slug> straight to /room/ regardless — but
// we still keep it at 'live' so any UI that reads state sees a healthy
// value.
//
// Response: { ok: true, slug, url, event: NeoEvent }
// Auth: signed-in only. 401 otherwise.

import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import {
  eventStore,
  generateId,
  generateQrSeed,
  generateSlug,
} from '@/lib/eventStore';
import { hsmoh } from '@/lib/hsmoh';
import type { NeoEvent } from '@/types/event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PERSONAL_ROOM_INDEX = 'neo:personal-room:'; // + userId -> event id

function originFrom(req: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/+$/, '');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('host') ?? 'localhost:3000';
  return proto + '://' + host;
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Fast path: user already has a personal room.
  try {
    const { kv } = await import('@vercel/kv');
    const existingId = await kv.get<string>(PERSONAL_ROOM_INDEX + userId);
    if (existingId) {
      const ev = await eventStore.byId(existingId);
      if (ev && ev.isPermanent && ev.ownerUserId === userId) {
        return NextResponse.json({
          ok: true,
          slug: ev.slug,
          url: originFrom(req) + '/' + ev.slug,
          event: ev,
        });
      }
      // Fall through and recreate — index was stale (event deleted or
      // ownership changed).
    }
  } catch {
    // KV blip — proceed to create; worst case we double-create and can
    // clean up later.
  }

  const u = await currentUser();
  const primaryEmail =
    u?.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ||
    u?.emailAddresses?.[0]?.emailAddress ||
    undefined;
  // generateSlug rejects the RESERVED_SLUGS set (admin, api, dashboard,
  // …) so a user whose first name matches one of those routes doesn't
  // end up with a slug that middleware will shadow.
  const baseName = u?.firstName || u?.username || 'me';
  const slug = await generateSlug(baseName, async (candidate) => {
    const existing = await eventStore.bySlug(candidate);
    return Boolean(existing);
  });

  const now = new Date().toISOString();
  const id = generateId();
  const longUrl = originFrom(req) + '/' + slug;

  let hsmohBinding: NeoEvent['hsmoh'] | undefined;
  if (hsmoh.isConfigured()) {
    try {
      const r = await hsmoh.shortenWithFallback(longUrl, slug);
      hsmohBinding = { shortCode: r.short_code, shortUrl: r.short_url };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[personal-room] hsmoh failed:', e);
    }
  }
  if (!hsmohBinding) {
    hsmohBinding = { shortCode: slug, shortUrl: longUrl, fallback: true };
  }

  const displayName = u?.firstName || u?.username || 'my';
  const ev: NeoEvent = {
    id,
    slug,
    name: `${displayName}'s room`,
    ownerUserId: userId,
    ownerEmail: primaryEmail?.toLowerCase(),
    visibility: 'unlisted',
    waitingRoomEnabled: false,
    livekitRoom: slug,
    hsmoh: hsmohBinding,
    qrSeed: generateQrSeed(),
    roles: [],
    waitingRoom: [],
    recordings: [],
    state: 'live',
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    isPermanent: true,
  };

  await eventStore.create(ev);

  try {
    const { kv } = await import('@vercel/kv');
    await kv.set(PERSONAL_ROOM_INDEX + userId, id);
  } catch {
    // Non-fatal: next call falls back to a re-create, but the event will
    // exist so this endpoint is idempotent from the caller's POV.
  }

  return NextResponse.json({
    ok: true,
    slug,
    url: longUrl,
    event: ev,
  });
}

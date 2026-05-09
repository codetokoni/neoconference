// src/app/api/events/create/route.ts
// One-call event provisioning: builds the LiveKit room name, optional StreamLab
// stream, optional HSMOH shortlink, and persists the NeoEvent to KV.

import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore, generateId, generateSlug, generateQrSeed } from '@/lib/eventStore';
import { streamlab } from '@/lib/streamlab';
import { hsmoh } from '@/lib/hsmoh';
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
  const slug = generateSlug(name);
  const livekitRoom = slug;
  const now = new Date().toISOString();

  let streamlabBinding: NeoEvent['streamlab'] | undefined;
  if (body.enableStream && streamlab.isConfigured()) {
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

  const longUrl = originFrom(req) + '/e/' + slug;
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
    password: body.password,
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

  return NextResponse.json({
    id: ev.id,
    slug: ev.slug,
    livekitRoom: ev.livekitRoom,
    qrUrl: '/api/qr/' + ev.slug,
    eventUrl: '/e/' + ev.slug,
    shortUrl: ev.hsmoh?.shortUrl,
    rtmpUrl: ev.streamlab?.rtmpUrl,
    streamKey: ev.streamlab?.streamKey,
    hlsUrl: ev.streamlab?.hlsUrl,
  });
}

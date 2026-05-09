// src/app/api/events/rename/route.ts
// Owner-only: rename an event's slug. The old slug is preserved as an alias
// so existing share links keep working. Also broadcasts an event_renamed
// data packet over LiveKit so any participants currently in the room
// auto-redirect to the new URL (brief reconnect).
//
// POST /api/events/rename body: { slug: string, newSlug: string }
// -> 200 { ok: true, slug, livekitRoom, roomUrl }

import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: { slug?: string; newSlug?: string };
  try {
    body = (await req.json()) as { slug?: string; newSlug?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const slug = (body.slug || '').trim().toLowerCase();
  const newSlug = (body.newSlug || '').trim().toLowerCase();
  if (!slug || !newSlug) return NextResponse.json({ error: 'missing_slug' }, { status: 400 });
  if (!SLUG_REGEX.test(newSlug)) return NextResponse.json({ error: 'invalid_slug' }, { status: 400 });

  const ev = await eventStore.bySlug(slug);
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Owner check: by Clerk userId or by snapshot email.
  const u = await currentUser().catch(() => null);
  const userEmails = (u?.emailAddresses || []).map(
    (e: { emailAddress: string }) => e.emailAddress.toLowerCase()
  );
  const ownerEmail = (ev.ownerEmail || '').toLowerCase();
  const isOwner =
    ev.ownerUserId === userId ||
    (ownerEmail !== '' && userEmails.includes(ownerEmail));
  if (!isOwner) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const oldLivekitRoom = ev.livekitRoom;
  const result = await eventStore.rename(ev.id, newSlug);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  // Best-effort: tell anyone currently in the OLD LiveKit room to redirect.
  try {
    const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (wsUrl && apiKey && apiSecret) {
      const httpUrl = wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
      const payload = JSON.stringify({
        type: 'event_renamed',
        oldSlug: slug,
        newSlug,
        roomUrl: '/room/' + newSlug + '?event=' + newSlug,
      });
      await svc.sendData(
        oldLivekitRoom,
        new TextEncoder().encode(payload),
        DataPacket_Kind.RELIABLE
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[events/rename] sendData failed:', e);
  }

  return NextResponse.json({
    ok: true,
    slug: result.event.slug,
    livekitRoom: result.event.livekitRoom,
    roomUrl: '/room/' + result.event.slug + '?event=' + result.event.slug,
  });
}

// src/app/api/events/delete/route.ts
// Owner-only: permanently delete an event.
// Removes the event record, all slugs (primary + aliases), the owner index,
// and the global ALL set. Broadcasts an event_deleted data packet so any
// participants currently in the room can be notified by the client.
//
// POST /api/events/delete body: { slug: string, confirm: string }
// confirm MUST equal slug (typed-confirm gate, like the GitHub repo-delete UX).
// -> 200 { ok: true }
// -> 400 missing_slug | invalid_json | confirm_mismatch
// -> 401 unauthenticated
// -> 403 forbidden
// -> 404 not_found

import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    let body: { slug?: string; confirm?: string };
    try {
          body = (await req.json()) as { slug?: string; confirm?: string };
        } catch {
          return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
        }
    const slug = (body.slug || '').trim().toLowerCase();
    const confirm = (body.confirm || '').trim().toLowerCase();
    if (!slug) return NextResponse.json({ error: 'missing_slug' }, { status: 400 });
    if (confirm !== slug) {
          return NextResponse.json({ error: 'confirm_mismatch' }, { status: 400 });
        }

    const ev = await eventStore.bySlug(slug);
    if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // Owner check: by Clerk userId or by snapshot email (same pattern as rename route).
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

    // Best-effort: tell anyone currently in the room that the event was deleted
    // BEFORE we actually delete it, so they can redirect home with a toast.
    try {
          const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL;
          const apiKey = process.env.LIVEKIT_API_KEY;
          const apiSecret = process.env.LIVEKIT_API_SECRET;
          if (wsUrl && apiKey && apiSecret) {
                  const httpUrl = wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
                  const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
                  const payload = JSON.stringify({
                            type: 'event_deleted',
                            slug,
                          });
                  await svc.sendData(
                            oldLivekitRoom,
                            new TextEncoder().encode(payload),
                            DataPacket_Kind.RELIABLE
                          );
                }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[events/delete] sendData failed:', e);
        }

    const ok = await eventStore.delete(ev.id);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    return NextResponse.json({ ok: true });
  }

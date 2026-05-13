// src/app/api/livekit/captions/dispatch/route.ts
//
// Dispatches the captions-worker (deployed on Railway) into a LiveKit room
// when a host or co-host enables live captions. Idempotent: if a dispatch
// already exists for the room+agent we return the existing one.
//
// The actual transcription gate is enforced by the worker itself via the
// 'captions' data-channel message. This route just makes sure the worker
// is present in the room so it can listen.

import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { AgentDispatchClient } from 'livekit-server-sdk';
import { eventStore } from '@/lib/eventStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIVEKIT_URL =
  process.env.NEXT_PUBLIC_LIVEKIT_URL ||
  process.env.LIVEKIT_WS_URL ||
  process.env.LIVEKIT_URL ||
  '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const AGENT_NAME = process.env.CAPTIONS_AGENT_NAME || 'neo-captions';

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: { room?: string; eventSlug?: string };
  try {
    body = (await req.json()) as { room?: string; eventSlug?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const roomName = (body.room || '').trim();
  const eventSlug = (body.eventSlug || '').trim() || roomName;
  if (!roomName) {
    return NextResponse.json({ error: 'room_required' }, { status: 400 });
  }

  // Authorize: only host or cohost on this event may dispatch the worker.
  // Mirrors the role-resolution logic in /api/events/role.
  try {
    const ev = await eventStore.bySlug(eventSlug);
    if (!ev) {
      return NextResponse.json({ error: 'event_not_found' }, { status: 404 });
    }
    const u = await currentUser().catch(() => null);
    const userEmails = (u?.emailAddresses || []).map(
      (e: { emailAddress: string }) => e.emailAddress.toLowerCase(),
    );
    const ownerEmail = (ev.ownerEmail || '').toLowerCase();
    const isOwner =
      ev.ownerUserId === userId ||
      (ownerEmail !== '' && userEmails.includes(ownerEmail));
    let role: string = isOwner ? 'host' : 'viewer';
    if (!isOwner) {
      const roles = ev.roles || [];
      const match = roles.find((r) => {
        const id = r.identifier.toLowerCase();
        return id === userId.toLowerCase() || userEmails.includes(id);
      });
      if (match) role = match.role;
    }
    if (role !== 'host' && role !== 'cohost') {
      return NextResponse.json({ error: 'forbidden', role }, { status: 403 });
    }
  } catch (e) {
    console.error('[captions/dispatch] event lookup failed', e);
    return NextResponse.json({ error: 'event_lookup_failed' }, { status: 500 });
  }

  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json(
      { error: 'livekit_not_configured' },
      { status: 500 },
    );
  }

  try {
    const httpsUrl = LIVEKIT_URL.replace(/^wss:\/\//, 'https://').replace(
      /^ws:\/\//,
      'http://',
    );
    const client = new AgentDispatchClient(
      httpsUrl,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
    );

    // De-dupe: if an active dispatch already exists for this room+agent,
    // return it. Otherwise create one.
    const existing = await client.listDispatch(roomName);
    const already = existing.find((d) => d.agentName === AGENT_NAME);
    if (already) {
      return NextResponse.json({
        ok: true,
        dispatched: false,
        dispatchId: already.id,
      });
    }

    const dispatch = await client.createDispatch(roomName, AGENT_NAME, {
      metadata: JSON.stringify({ requestedBy: userId, eventSlug }),
    });
    return NextResponse.json({
      ok: true,
      dispatched: true,
      dispatchId: dispatch.id,
    });
  } catch (e) {
    console.error('[captions/dispatch] failed', e);
    return NextResponse.json(
      {
        error: 'dispatch_failed',
        detail: String((e as Error)?.message || e),
      },
      { status: 500 },
    );
  }
}

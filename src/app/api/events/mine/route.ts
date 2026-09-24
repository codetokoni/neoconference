// src/app/api/events/mine/route.ts
//
// GET /api/events/mine
// The signed-in user's own events, newest activity first.
//
// The dashboard reads this list straight out of Redis because it is a
// server component. The mobile app cannot, so this exposes the same list
// over HTTP. It is deliberately a projection rather than the whole
// NeoEvent: a phone list needs a name, a state and a slug to join with,
// not the roles array, the waiting room and every recording.
//
// Scope note: this returns events the user *owns*. Events they were merely
// invited to are not included, because roles are stored on the event with
// no reverse index from user to event — there is nothing to read without
// scanning every event. Those are reached by their link, as on the web.
//
// Response: { ok: true, events: EventSummary[] }
// Auth: signed-in only. 401 otherwise.

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import type { NeoEvent } from '@/types/event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type EventSummary = {
  id: string;
  slug: string;
  name: string;
  state: NeoEvent['state'];
  visibility: NeoEvent['visibility'];
  livekitRoom: string;
  isPermanent: boolean;
  isLocked: boolean;
  waitingRoomEnabled: boolean;
  scheduledAt?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
};

function summarize(ev: NeoEvent): EventSummary {
  return {
    id: ev.id,
    slug: ev.slug,
    name: ev.name,
    state: ev.state,
    visibility: ev.visibility,
    livekitRoom: ev.livekitRoom,
    isPermanent: Boolean(ev.isPermanent),
    isLocked: Boolean(ev.isLocked),
    waitingRoomEnabled: Boolean(ev.waitingRoomEnabled),
    scheduledAt: ev.scheduledAt,
    startedAt: ev.startedAt,
    endedAt: ev.endedAt,
    updatedAt: ev.updatedAt,
  };
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const events = await eventStore.listByOwner(userId);
  // Live first, then whatever was touched most recently — the order a
  // person scanning a phone screen wants, rather than creation order.
  const rank = (e: NeoEvent) => (e.state === 'live' ? 0 : e.state === 'waiting' ? 1 : 2);
  events.sort(
    (a, b) => rank(a) - rank(b) || (b.updatedAt || '').localeCompare(a.updatedAt || '')
  );

  return NextResponse.json({ ok: true, events: events.map(summarize) });
}

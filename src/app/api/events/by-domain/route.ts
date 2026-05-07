// src/app/api/events/by-domain/route.ts
//
// Public, read-only lookup: given a host like live.acme.com, return the slug
// of the event bound to it (or 404). Used by middleware to rewrite custom
// domains onto /e/<slug>. Cached for 60 seconds at the edge.
//
// GET /api/events/by-domain?host=live.acme.com
//   200 -> { slug, name, ownerName }
//   404 -> not bound
//
// This route is intentionally unauthenticated so middleware can call it on
// every cold request without provoking a Clerk roundtrip.

import { NextRequest, NextResponse } from 'next/server';
import { eventStore } from '@/lib/eventStore';

export const runtime = 'nodejs';
export const revalidate = 60;

export async function GET(req: NextRequest) {
  const host = (req.nextUrl.searchParams.get('host') || '').trim().toLowerCase();
  if (!host) {
    return NextResponse.json({ error: 'host_required' }, { status: 400 });
  }

  // Reject canonical hosts so this endpoint can never be used to route the app to itself.
  if (host.endsWith('.vercel.app') || host === 'neoconference.vercel.app' || host.startsWith('localhost')) {
    return NextResponse.json({ error: 'reserved_host' }, { status: 404 });
  }

  try {
    const all = await eventStore.listAll();
    const match = all.find((e) => (e.customDomain || '').toLowerCase() === host && e.state !== 'archived');
    if (!match) {
      return NextResponse.json({ error: 'not_bound' }, { status: 404, headers: { 'Cache-Control': 'public, s-maxage=60' } });
    }
    return NextResponse.json(
      { slug: match.slug, name: match.name, ownerName: match.ownerName },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } }
    );
  } catch {
    return NextResponse.json({ error: 'lookup_failed' }, { status: 500 });
  }
}


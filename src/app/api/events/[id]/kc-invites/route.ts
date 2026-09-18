// src/app/api/events/[id]/kc-invites/route.ts
//
// GET /api/events/[id]/kc-invites
// Returns every KingsChat-handle role currently persisted in this
// event's meeting-roles hash — the assignments you made via
// /api/events/[id]/invite-kc — so the dashboard can show them
// across page reloads, not just as in-session outcome pills.
//
// Response: { ok: true, items: [{ handle, role, addedAt }] }
// Auth: owner-or-host (matches the invite-kc endpoint's own gate).

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { authorize } from '@/lib/authz';
import { getMeetingParticipants, removeMeetingRole } from '@/lib/meeting-roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const ev = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const gate = await authorize(ev, 'role:grant');
  if (!gate.ok) return gate.response;

  const participants = await getMeetingParticipants(ev.id, ev);
  // Filter to rows keyed by kc:<handle>. Owner (from event) and
  // userId / email rows aren't part of this listing.
  const items = participants
    .filter((p) => p.userId.startsWith('kc:'))
    .map((p) => ({
      handle: p.userId.slice(3),
      role: p.role,
      addedAt: p.assignedAt,
    }))
    .sort((a, b) => b.addedAt - a.addedAt);

  return NextResponse.json({ ok: true, items });
}

// DELETE /api/events/[id]/kc-invites
// Body: { handle: string }
// Revokes the KC-handle's role for this event by clearing its row in
// the meeting-roles hash. Owner-or-host gated, same as GET.
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const ev = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const gate = await authorize(ev, 'role:revoke');
  if (!gate.ok) return gate.response;

  let body: { handle?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const raw = typeof body.handle === 'string' ? body.handle.trim() : '';
  if (!raw) {
    return NextResponse.json({ error: 'missing_handle' }, { status: 400 });
  }
  const handle = (raw.startsWith('@')
    ? raw.slice(1)
    : raw.toLowerCase().startsWith('kc:')
      ? raw.slice(3)
      : raw
  ).toLowerCase();

  try {
    await removeMeetingRole(ev.id, { userId: 'kc:' + handle });
  } catch (err) {
    console.error('[events/kc-invites] remove failed', err);
    return NextResponse.json({ error: 'remove_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

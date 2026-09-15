// src/app/api/admin/events/transfer/route.ts
//
// Admin-only endpoint to transfer an event's ownership to a different
// user identified by email. Rewires:
//   - event.ownerUserId  (the field the app reads for plan-cap lookups
//                         and "you own this event" checks)
//   - OWNER index in KV  (add to new owner set, remove from old — so
//                         listByOwner returns the right set for both)
//
// Reason this exists: standing rooms like /room/hsmanagers are bound
// to whoever first created them, and there was no clean way to hand
// them off to a different account (e.g. a moderator leaves the org;
// the event's ownership needs to move to the admin's own account
// before anyone can act on it via the plan-cap flow).
//
// Kept as a permanent admin surface — the same shape works for any
// future "transfer this event" ask, not just the one-shot that
// motivated it.

import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { kv } from '@vercel/kv';
import { requireRole } from '@/lib/roles';
import { eventStore } from '@/lib/eventStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OWNER_KEY = 'neo:owner:';

export async function POST(req: Request) {
  const caller = await requireRole(['admin']);
  if (!caller) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: { slug?: unknown; id?: unknown; newOwnerEmail?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }

  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const explicitId = typeof body.id === 'string' ? body.id.trim() : '';
  const email = typeof body.newOwnerEmail === 'string'
    ? body.newOwnerEmail.trim().toLowerCase()
    : '';
  if (!email) {
    return NextResponse.json(
      { error: 'newOwnerEmail_required' },
      { status: 400 },
    );
  }
  if (!slug && !explicitId) {
    return NextResponse.json(
      { error: 'slug_or_id_required' },
      { status: 400 },
    );
  }

  // Resolve the event. Prefer the explicit id when provided; fall
  // back to slug lookup — most callers only know the slug from the
  // /room/<slug> URL.
  const ev = explicitId
    ? await eventStore.byId(explicitId)
    : await eventStore.bySlug(slug);
  if (!ev) {
    return NextResponse.json(
      { error: 'event_not_found', slug: slug || undefined, id: explicitId || undefined },
      { status: 404 },
    );
  }

  // Resolve the target user by email via Clerk. Emails on Clerk are
  // stored per-EmailAddress record — getUserList's emailAddress
  // param does the joined lookup for us.
  const cc = await clerkClient();
  const list = await cc.users.getUserList({ emailAddress: [email], limit: 1 });
  const newOwner = list.data?.[0];
  if (!newOwner) {
    return NextResponse.json(
      { error: 'target_user_not_found', email },
      { status: 404 },
    );
  }
  const newOwnerUserId = newOwner.id;
  const oldOwnerUserId = ev.ownerUserId;

  if (oldOwnerUserId === newOwnerUserId) {
    return NextResponse.json(
      { ok: true, alreadyOwner: true, event: ev },
    );
  }

  // Patch the event record itself.
  const updated = await eventStore.update(ev.id, {
    ownerUserId: newOwnerUserId,
  });
  if (!updated) {
    return NextResponse.json(
      { error: 'update_failed' },
      { status: 500 },
    );
  }

  // Rewire the OWNER index so listByOwner returns the event under
  // the new owner and not the old. eventStore.update doesn't touch
  // these sets — they're an eventStore internal we happen to know
  // because the module lives alongside.
  try {
    await kv.srem(OWNER_KEY + oldOwnerUserId, ev.id);
  } catch {
    // Best-effort — the old owner's set may not exist in-memory mode.
  }
  try {
    await kv.sadd(OWNER_KEY + newOwnerUserId, ev.id);
  } catch {
    // Same — in-memory mode has no KV.
  }

  return NextResponse.json({
    ok: true,
    event: updated,
    transferredFrom: oldOwnerUserId,
    transferredTo: newOwnerUserId,
    newOwnerEmail: email,
  });
}

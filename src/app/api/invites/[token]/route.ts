// src/app/api/invites/[token]/route.ts
//
// Public invite preview + redeem endpoint.
// GET  - returns sanitized preview (event name, role, expiry status). No mutation.
// POST - redeems the token: increments uses, upserts a RoleAssignment on the event.
//
// Auth: GET is public. POST requires a signed-in Clerk user; the redemption
// is bound to that userId so the same person who clicks the link gets the role.

import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { inviteStore } from '@/lib/inviteStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { token: string } }
) {
  const inv = await inviteStore.get(params.token);
  if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const ev = await eventStore.byId(inv.eventId);
  if (!ev) return NextResponse.json({ error: "event_missing" }, { status: 410 });

  const expired = inv.expiresAt ? new Date(inv.expiresAt).getTime() < Date.now() : false;
  const exhausted = inv.uses >= inv.maxUses;

  return NextResponse.json({
    invite: {
      role: inv.role,
      label: inv.label,
      expiresAt: inv.expiresAt,
      remaining: Math.max(0, inv.maxUses - inv.uses),
      expired,
      exhausted,
    },
    event: {
      slug: ev.slug,
      name: ev.name,
      ownerName: ev.ownerName,
    },
  });
}

export async function POST(
  _req: Request,
  { params }: { params: { token: string } }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const inv = await inviteStore.get(params.token);
  if (!inv) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if (inv.uses >= inv.maxUses) {
    return NextResponse.json({ error: "exhausted" }, { status: 410 });
  }

  const ev = await eventStore.byId(inv.eventId);
  if (!ev) return NextResponse.json({ error: "event_missing" }, { status: 410 });

  // Atomic redeem
  const redeemed = await inviteStore.redeem(params.token);
  if (!redeemed) return NextResponse.json({ error: "race" }, { status: 409 });

  // Upsert role on event
  const u = await currentUser();
  const label = u?.firstName || u?.username || (u?.emailAddresses?.[0]?.emailAddress?.split("@")[0]) || "Guest";
  const roles = [...(ev.roles || [])];
  const idx = roles.findIndex((r) => r.identifier === userId);
  if (idx >= 0) {
    roles[idx] = { ...roles[idx], role: inv.role as any, preApproved: true, label: roles[idx].label || label };
  } else {
    roles.push({ identifier: userId, role: inv.role as any, preApproved: true, label });
  }
  // Track this redemption (newest 50, prune oldest).
  const redemption = { token: params.token, identifier: userId, role: inv.role, ts: Date.now() };
  const recentRedemptions = [redemption, ...((ev.recentRedemptions || []) as any[])].slice(0, 50);
  await eventStore.update(ev.id, { roles, recentRedemptions });

  return NextResponse.json({ ok: true, eventSlug: ev.slug, role: inv.role });
}


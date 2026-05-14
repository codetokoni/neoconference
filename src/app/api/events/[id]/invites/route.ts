// src/app/api/events/[id]/invites/route.ts
//
// Owner-only invite minting + listing.
// POST: mint a new InviteToken (role, maxUses, expiresInHours, label)
// GET:  list all outstanding invites for the event

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { inviteStore } from '@/lib/inviteStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_ROLES = new Set(['cohost','speaker','attendee','ticket-holder']);

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ev = await eventStore.byId(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ev.ownerUserId !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const invites = await inviteStore.listForEvent(ev.id);
  return NextResponse.json({ ok: true, invites });
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ev = await eventStore.byId(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ev.ownerUserId !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: any = {};
  try { body = await req.json(); } catch {}

  const role = String(body?.role || "attendee");
  if (!VALID_ROLES.has(role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }
  const maxUses = Math.max(1, Math.min(1000, parseInt(String(body?.maxUses || "1"), 10) || 1));
  const hours = body?.expiresInHours ? Math.max(1, Math.min(24 * 365, parseInt(String(body.expiresInHours), 10) || 0)) : 0;
  const expiresAt = hours > 0 ? new Date(Date.now() + hours * 3600_000).toISOString() : undefined;
  const label = body?.label ? String(body.label).slice(0, 80) : undefined;

  const invite = await inviteStore.create({
    eventId: ev.id,
    role,
    maxUses,
    expiresAt,
    createdBy: userId,
    label,
  });

  return NextResponse.json({ ok: true, invite });
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ev = await eventStore.byId(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ev.ownerUserId !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: any = {};
  try { body = await req.json(); } catch {}
  const token = String(body?.token || "");
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });
  await inviteStore.revoke(token);
  return NextResponse.json({ ok: true });
}


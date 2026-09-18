// src/app/api/user/recurring-roles/route.ts
//
// Manage the caller's personal "recurring roles" list — people who
// should automatically be host/moderator/cohost/speaker in every new
// event the caller creates.
//
// GET    -> { ok: true, items: RecurringRoleListItem[] }
// POST   { identifier: string, role: MeetingRole } -> { ok: true }
// DELETE { identifier: string }                    -> { ok: true }
//
// Auth: signed-in only. 401 otherwise.
// Role must be one of: host, cohost, moderator, speaker. "participant"
// is not stored — no participant is more permanent than not being on
// the list at all — and "owner" is not grantable through this API.

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import {
  listRecurringRoles,
  addRecurringRole,
  removeRecurringRole,
} from '@/lib/recurring-roles';
import { isMeetingRole, type MeetingRole } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// See ALLOWED comment on /api/events/[id]/invite-kc — cohost / speaker
// are display aliases, not real MeetingRole values.
const ALLOWED_ROLES: MeetingRole[] = ['host', 'moderator'];

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const items = await listRecurringRoles(userId);
  return NextResponse.json({ ok: true, items });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: { identifier?: unknown; role?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const identifier =
    typeof body.identifier === 'string' ? body.identifier.trim() : '';
  if (!identifier) {
    return NextResponse.json({ error: 'missing_identifier' }, { status: 400 });
  }
  const role = typeof body.role === 'string' ? body.role : '';
  if (!isMeetingRole(role) || !ALLOWED_ROLES.includes(role as MeetingRole)) {
    return NextResponse.json({ error: 'invalid_role' }, { status: 400 });
  }

  try {
    await addRecurringRole(userId, identifier, role as MeetingRole);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'write_failed' },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: { identifier?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const identifier =
    typeof body.identifier === 'string' ? body.identifier.trim() : '';
  if (!identifier) {
    return NextResponse.json({ error: 'missing_identifier' }, { status: 400 });
  }
  await removeRecurringRole(userId, identifier);
  return NextResponse.json({ ok: true });
}

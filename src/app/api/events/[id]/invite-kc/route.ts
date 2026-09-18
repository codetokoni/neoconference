// src/app/api/events/[id]/invite-kc/route.ts
//
// Per-event invite by KingsChat handle. Adds the handle to this event's
// meeting-roles hash so the person picks up their role the moment they
// sign in with KingsChat, and (optionally) pushes an invite message
// directly to their KingsChat via the server-side sender.
//
// Sits alongside the email-magic-link path in /api/events/[id]/invite —
// same guardrails (owner-or-admin), different rail.
//
// POST body: { handle: string, role: MeetingRole, sendMessage?: boolean }
//   handle       KC handle with or without leading @, or "kc:foo"
//   role         host | cohost | moderator | speaker
//   sendMessage  true (default) -> also push a KC message when the
//                recipient has linked KC. false -> only assign the role,
//                caller will paste the invite manually.
//
// Responses:
//   200 { ok: true, assigned: true, sent: boolean, sendReason?: string }
//   400 invalid_json | missing_fields | invalid_role
//   401 unauthenticated
//   403 forbidden
//   404 not_found

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { authorize } from '@/lib/authz';
import { assignMeetingRole } from '@/lib/meeting-roles';
import { isMeetingRole, type MeetingRole } from '@/lib/permissions';
import { sendKcMessage } from '@/lib/kingschat-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED: MeetingRole[] = ['host', 'cohost', 'moderator', 'speaker'];

function normalizeHandle(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const stripped = s.startsWith('@')
    ? s.slice(1)
    : s.toLowerCase().startsWith('kc:')
      ? s.slice(3)
      : s;
  return stripped.toLowerCase();
}

function inviteMessage(
  handle: string,
  role: MeetingRole,
  eventName: string,
  eventUrl: string,
): string {
  return (
    'Hi @' + handle + ' — you\'ve been invited as ' + role +
    ' to "' + eventName + '" on NeoConference. Join at ' + eventUrl +
    ' — sign in via KingsChat, Neomail, or email and your ' + role +
    ' role is applied automatically.'
  );
}

async function resolveClerkUserFromKc(handle: string): Promise<string | null> {
  const { clerkClient } = await import('@clerk/nextjs/server');
  try {
    const cc = await clerkClient();
    const list = await cc.users.getUserList({ limit: 500 });
    for (const u of list.data) {
      const meta = (u.publicMetadata as { kingschat?: { username?: string } })?.kingschat;
      if (meta?.username && meta.username.toLowerCase() === handle) {
        return u.id;
      }
    }
  } catch (err) {
    console.error('[events/invite-kc] clerk lookup failed', err);
  }
  return null;
}

export async function POST(
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

  const gate = await authorize(ev, 'role:grant');
  if (!gate.ok) return gate.response;

  let body: { handle?: unknown; role?: unknown; sendMessage?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const handle = normalizeHandle(
    typeof body.handle === 'string' ? body.handle : '',
  );
  const role = typeof body.role === 'string' ? body.role : '';
  const sendMessage = body.sendMessage !== false;

  if (!handle) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }
  if (!isMeetingRole(role) || !ALLOWED.includes(role as MeetingRole)) {
    return NextResponse.json({ error: 'invalid_role' }, { status: 400 });
  }

  // Assign the role under the kc:<handle> key. /api/events/role and
  // /api/livekit/token both probe this key at rejoin time using the
  // caller's publicMetadata.kingschat.username, so the role applies
  // the moment the recipient next signs in via KingsChat — no re-
  // invite needed.
  try {
    await assignMeetingRole(
      ev.id,
      { userId: 'kc:' + handle },
      role as MeetingRole,
      gate.actor,
    );
  } catch (err) {
    console.error('[events/invite-kc] assign failed', err);
    return NextResponse.json(
      { error: 'assign_failed' },
      { status: 500 },
    );
  }

  let sent = false;
  let sendReason: string | undefined;

  if (sendMessage) {
    const origin =
      req.headers.get('origin') ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      'https://www.neoconference.app';
    const eventUrl = origin.replace(/\/+$/, '') + '/' + ev.slug;
    const message = inviteMessage(handle, role as MeetingRole, ev.name, eventUrl);

    const targetClerkId = await resolveClerkUserFromKc(handle);
    if (!targetClerkId) {
      sendReason = 'not_linked';
    } else {
      const result = await sendKcMessage(targetClerkId, message);
      if (result.ok) {
        sent = true;
      } else {
        sendReason = result.reason;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    assigned: true,
    sent,
    sendReason,
  });
}

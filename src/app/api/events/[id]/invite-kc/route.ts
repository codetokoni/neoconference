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

// The underlying MeetingRole ladder is owner | host | moderator |
// participant. Cohost / speaker are display aliases (see
// LEGACY_ROLE_MAP in permissions.ts) — cohost normalizes to
// moderator, speaker collapses to participant. Only the two real
// grantable ranks are accepted here.
const ALLOWED: MeetingRole[] = ['host', 'moderator'];

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
  // Fast path: KV index written by the KC OAuth callback every time
  // someone signs in. O(1) for anyone who has signed in via KC since
  // that indexing landed.
  try {
    const { findClerkIdByKcHandle } = await import('@/lib/kc-tokens');
    const cached = await findClerkIdByKcHandle(handle);
    if (cached) return cached;
  } catch (err) {
    console.warn('[events/invite-kc] handle index lookup failed', err);
  }
  // Slow fallback: linear scan of Clerk users. Kept so people who
  // signed in via KC BEFORE the indexing shipped are still findable
  // once — the index gets populated on their next sign-in.
  const { clerkClient } = await import('@clerk/nextjs/server');
  try {
    const cc = await clerkClient();
    const list = await cc.users.getUserList({ limit: 500 });
    for (const u of list.data) {
      const meta = (u.publicMetadata as { kingschat?: { username?: string } })?.kingschat;
      if (meta?.username && meta.username.toLowerCase() === handle) {
        // Backfill the index so future lookups skip the scan.
        try {
          const { indexKcHandle } = await import('@/lib/kc-tokens');
          await indexKcHandle(handle, u.id);
        } catch {
          // non-fatal
        }
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
      // The recipient has never signed in via KingsChat here — we have
      // no Clerk user for them. Distinct from "we have the user but
      // their tokens expired or predate indexing", which comes back
      // from sendKcMessage below as its own reason.
      sendReason = 'recipient_never_signed_in';
    } else {
      const result = await sendKcMessage(targetClerkId, message);
      if (result.ok) {
        sent = true;
      } else if (result.reason === 'not_linked' || result.reason === 'no_refresh') {
        // We know the user but have no usable tokens. Usually means
        // they signed in via KC before token-persistence shipped —
        // asking them to sign back in once will fix it forever.
        sendReason = 'tokens_missing';
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

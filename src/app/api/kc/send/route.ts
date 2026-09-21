// src/app/api/kc/send/route.ts
//
// POST /api/kc/send
// Push a plain-text message to a KingsChat user linked to the caller's
// Recurring Roles list.
//
// Body: { handle: string, message: string }
//   handle   the KC handle to deliver to (with or without a leading @)
//   message  plain text, ≤ 800 chars
//
// Responses:
//   200 { ok: true }
//   400 invalid_json | missing_fields | too_long
//   401 unauthenticated
//   403 not_in_recurring   caller hasn't added this handle to their
//                          Recurring Roles list. Prevents this endpoint
//                          from being used as an open-relay send-to-
//                          anyone tool.
//   404 recipient_not_found   no Clerk user with that KC username has
//                             ever signed in via our app, so we have no
//                             KingsChat id to address the message to
//   409 sender_not_linked     the CALLER has no usable KingsChat tokens.
//                             Messages go out from the sender's account,
//                             so the sender signs in with KingsChat once.
//   502 send_failed  KC send endpoint returned an error

import { NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { listRecurringRoles } from '@/lib/recurring-roles';
import { kcIdForClerkUser, sendKcMessage } from '@/lib/kingschat-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LEN = 800;

function normalizeHandle(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const stripped = s.startsWith('@') ? s.slice(1) : s.replace(/^kc:/i, '');
  return stripped.toLowerCase();
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: { handle?: unknown; message?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const handle = normalizeHandle(typeof body.handle === 'string' ? body.handle : '');
  const message = (typeof body.message === 'string' ? body.message : '').trim();
  if (!handle || !message) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }
  if (message.length > MAX_LEN) {
    return NextResponse.json({ error: 'too_long', max: MAX_LEN }, { status: 400 });
  }

  // Authorization: the handle must be on this caller's Recurring Roles
  // list. Anyone can send to their own recurring people; nobody can
  // arbitrarily push to strangers through this route.
  const list = await listRecurringRoles(userId);
  const authorized = list.some(
    (r) => r.isKcHandle && r.identifier === 'kc:' + handle,
  );
  if (!authorized) {
    return NextResponse.json({ error: 'not_in_recurring' }, { status: 403 });
  }

  // Resolve KC handle -> Clerk user. Fast path: KV handle index written
  // by the KC OAuth callback. Slow fallback: Clerk publicMetadata scan
  // for people whose KC sign-in predates the indexing shipping.
  let targetClerkId: string | null = null;
  try {
    const { findClerkIdByKcHandle, indexKcHandle } = await import('@/lib/kc-tokens');
    targetClerkId = await findClerkIdByKcHandle(handle);
    if (!targetClerkId) {
      const cc = await clerkClient();
      const list1 = await cc.users.getUserList({ limit: 500 });
      for (const u of list1.data) {
        const meta = (u.publicMetadata as { kingschat?: { username?: string } })?.kingschat;
        if (meta?.username && meta.username.toLowerCase() === handle) {
          targetClerkId = u.id;
          try { await indexKcHandle(handle, u.id); } catch {}
          break;
        }
      }
    }
  } catch (err) {
    console.error('[kc/send] clerk lookup failed', err);
  }
  if (!targetClerkId) {
    return NextResponse.json({ error: 'recipient_not_found' }, { status: 404 });
  }

  // From the signed-in user's KingsChat account to the recipient's
  // KingsChat id — see lib/kingschat-send for why it has to be this way.
  const recipientKcId = await kcIdForClerkUser(targetClerkId);
  if (!recipientKcId) {
    return NextResponse.json({ error: 'recipient_not_found' }, { status: 404 });
  }

  const result = await sendKcMessage(userId, recipientKcId, message);
  if (result.ok) return NextResponse.json({ ok: true });

  if (result.reason === 'sender_not_linked') {
    // The sender, not the recipient, needs to sign in with KingsChat.
    return NextResponse.json({ error: 'sender_not_linked' }, { status: 409 });
  }
  return NextResponse.json(
    { error: 'send_failed', reason: result.reason, detail: result.body },
    { status: 502 },
  );
}

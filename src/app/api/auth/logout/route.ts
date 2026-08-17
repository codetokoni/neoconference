// src/app/api/auth/logout/route.ts
//
// scope=device -> revoke this browser's session only.
// scope=all    -> revoke every session for the user, on every device.

import { NextRequest, NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { SESSION_COOKIE, logout } from '@/lib/sessionStore';

/**
 * Revoking the KV sessions alone does NOT sign other devices out: each one still
 * holds a live Clerk session, so <SessionBootstrap /> mints a fresh persistent
 * session on the next page load and the user is straight back in. "Everywhere"
 * only means everywhere if Clerk is revoked too.
 *
 * Best-effort: failures are logged, never thrown — the KV revocation has already
 * happened by the time this runs, so a Clerk hiccup must not fail the sign-out.
 */
async function revokeClerkSessions(userId: string): Promise<void> {
  try {
    const cc = await clerkClient();
    const list = await cc.sessions.getSessionList({
      userId,
      status: 'active',
      limit: 100,
    });

    const results = await Promise.allSettled(
      list.data.map((session) => cc.sessions.revokeSession(session.id)),
    );

    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      console.error('[api/auth/logout] Clerk revoke failed for', failed, 'session(s)');
    }
    if (typeof list.totalCount === 'number' && list.totalCount > list.data.length) {
      console.warn(
        '[api/auth/logout] user has more than 100 active Clerk sessions;',
        list.totalCount - list.data.length,
        'not revoked',
      );
    }
  } catch (error) {
    console.error('[api/auth/logout] Clerk session revocation failed', error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // State-changing endpoint. SameSite=Lax still allows some top-level
    // cross-site POSTs, so reject anything not from our own origin.
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const scope: 'device' | 'all' =
      request.nextUrl.searchParams.get('scope') === 'all' ? 'all' : 'device';

    const token = request.cookies.get(SESSION_COOKIE)?.value ?? null;

    // A missing cookie is not an error: signing out must always succeed, and
    // scope=all has to work even when this device's cookie is already gone.
    await logout(userId, token, scope);

    if (scope === 'all') {
      await revokeClerkSessions(userId);
    }

    const response = NextResponse.json({ success: true, scope }, { status: 200 });
    response.cookies.set(SESSION_COOKIE, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return response;
  } catch (error) {
    console.error('[api/auth/logout] failed', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

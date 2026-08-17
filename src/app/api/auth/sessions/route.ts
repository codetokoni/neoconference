// src/app/api/auth/sessions/route.ts
//
// Lists the signed-in user's active devices so they can spot one they don't
// recognise and use "Sign out everywhere".

import { NextRequest, NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { SESSION_COOKIE, getActiveSessions } from '@/lib/sessionStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The set of Clerk sessions still alive for this user, so the device list can
 * drop rows whose Clerk session was ended elsewhere — the Clerk dashboard, or
 * the "Sign out of this device" link in Clerk's new-device email. Those devices
 * are already locked out by auth.protect(); this stops them lingering in the UI,
 * where a stale row is exactly what you'd misread during a real incident.
 *
 * Returns null if Clerk can't be reached, which means "don't reconcile" rather
 * than "everything is revoked" — a Clerk blip must not blank the device list.
 */
async function activeClerkSessionIds(userId: string): Promise<Set<string> | null> {
  try {
    const cc = await clerkClient();
    const list = await cc.sessions.getSessionList({ userId, status: 'active', limit: 100 });
    return new Set(list.data.map((s) => s.id));
  } catch (error) {
    console.error('[api/auth/sessions] could not list Clerk sessions', error);
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = request.cookies.get(SESSION_COOKIE)?.value ?? null;
    const clerkSessionIds = await activeClerkSessionIds(userId);
    const sessions = await getActiveSessions(userId, token, clerkSessionIds);

    return NextResponse.json({ success: true, sessions });
  } catch (error) {
    console.error('[api/auth/sessions] failed', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

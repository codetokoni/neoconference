// src/app/api/auth/logout/route.ts
//
// scope=device -> revoke this browser's session only.
// scope=all    -> revoke every session for the user, on every device.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { SESSION_COOKIE, logout } from '@/lib/sessionStore';

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

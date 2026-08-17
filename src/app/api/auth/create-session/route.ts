// src/app/api/auth/create-session/route.ts
//
// Mints the persistent device session after a successful Clerk sign-in
// (including the KingsChat flow, which finishes by signing the user into Clerk
// with a ticket). Called by <SessionBootstrap /> once the Clerk session loads.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import {
  SESSION_COOKIE,
  createSession,
  generateDeviceFingerprint,
  getClientIp,
  sessionCookieOptions,
  validateSession,
} from '@/lib/sessionStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // The user id comes from the verified Clerk session and NOWHERE else.
    // Reading it from the request body would let anyone mint a session cookie
    // for any account by guessing a user id.
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userAgent = request.headers.get('user-agent') || '';
    const acceptLanguage = request.headers.get('accept-language') || '';
    const fingerprint = await generateDeviceFingerprint(userAgent, acceptLanguage);
    const ip = getClientIp(request.headers);

    // Idempotent: a refresh should not churn sessions or rotate the cookie.
    const existing = request.cookies.get(SESSION_COOKIE)?.value;
    if (existing) {
      const result = await validateSession(existing, ip, fingerprint);
      if (result.status === 'valid' && result.userId === userId) {
        return NextResponse.json({ success: true, created: false }, { status: 200 });
      }
    }

    const token = await createSession(userId, { ip, fingerprint, userAgent });

    // The token goes out ONLY as an httpOnly cookie. Returning it in the JSON
    // body would expose it to any script on the page and defeat httpOnly.
    const response = NextResponse.json({ success: true, created: true }, { status: 201 });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return response;
  } catch (error) {
    console.error('[api/auth/create-session] failed', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

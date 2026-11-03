// src/app/api/auth/signed-out-reason/route.ts
//
// GET ?session=<Clerk session id> -> { reason, message } for a device whose
// session ended, so it can say why ("…signed in on another device") rather
// than only showing the sign-in screen. Public: the asker is signed out by
// then. A session id is a random identifier its own device holds; the answer
// is only which of two reasons, or null.

import { NextRequest, NextResponse } from 'next/server';
import { SIGNED_OUT_MESSAGE, signedOutReason } from '@/lib/deviceSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = request.nextUrl.searchParams.get('session') ?? '';
  const reason = await signedOutReason(session);
  return NextResponse.json(
    { reason, message: reason ? SIGNED_OUT_MESSAGE[reason] : null },
    { headers: { 'cache-control': 'no-store' } },
  );
}

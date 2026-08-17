// src/app/api/auth/sessions/route.ts
//
// Lists the signed-in user's active devices so they can spot one they don't
// recognise and use "Sign out everywhere".

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { SESSION_COOKIE, getActiveSessions } from '@/lib/sessionStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = request.cookies.get(SESSION_COOKIE)?.value ?? null;
    const sessions = await getActiveSessions(userId, token);

    return NextResponse.json({ success: true, sessions });
  } catch (error) {
    console.error('[api/auth/sessions] failed', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

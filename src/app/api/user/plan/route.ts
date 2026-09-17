// src/app/api/user/plan/route.ts
//
// GET /api/user/plan
// Returns the caller's plan + PlanLimits so the client can gate UI
// against plan-driven features (livestream checkbox on
// /dashboard/new, upgrade prompts, etc.) without hitting a
// separate LiveKit token flow first.
//
// Auth: signed-in Clerk users only. Returns 401 otherwise —
// unauthenticated callers have no plan to look up.

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getPlanForUserId, getPlanLimits } from '@/lib/plan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  try {
    const plan = await getPlanForUserId(userId);
    const limits = getPlanLimits(plan);
    return NextResponse.json({ ok: true, plan, limits });
  } catch (err) {
    console.error('[user/plan] lookup failed:', err);
    return NextResponse.json({ error: 'lookup_failed' }, { status: 500 });
  }
}

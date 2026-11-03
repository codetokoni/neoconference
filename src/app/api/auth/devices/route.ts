// src/app/api/auth/devices/route.ts
//
// Settings → Security → Device sessions, for the website and the app:
//
//   GET                                   -> { multiDevice, devices }
//   POST { action: "sign_out", id }       -> signs out one of your devices
//   POST { action: "sign_out_others" }    -> every device but this one
//   POST { action: "multi", on }          -> "Allow login on multiple devices";
//                                            off signs out the other devices
//
// The account and this device come from the verified Clerk session only.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import {
  allowsMultipleDevices,
  listDevices,
  setMultipleDevices,
  signOutDevice,
  signOutOtherDevices,
} from '@/lib/deviceSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const err = (error: string, message: string, status: number) => NextResponse.json({ error, message }, { status });

async function state(userId: string, sessionId: string) {
  const [multiDevice, devices] = await Promise.all([allowsMultipleDevices(userId), listDevices(userId, sessionId)]);
  return { multiDevice, devices };
}

export async function GET() {
  const { userId, sessionId } = await auth();
  if (!userId || !sessionId) return err('unauthorized', 'Sign in first.', 401);
  try {
    return NextResponse.json(await state(userId, sessionId), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[api/auth/devices] list failed', error);
    return err('unavailable', 'Could not load your devices. Try again.', 503);
  }
}

export async function POST(request: NextRequest) {
  const { userId, sessionId } = await auth();
  if (!userId || !sessionId) return err('unauthorized', 'Sign in first.', 401);

  // A browser's cross-site POST carries its origin; the app sends none.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return err('forbidden', 'Forbidden', 403);

  const body = (await request.json().catch(() => null)) as { action?: unknown; id?: unknown; on?: unknown } | null;
  try {
    if (body?.action === 'sign_out') {
      if (typeof body.id !== 'string' || !body.id) return err('bad_request', 'Which device?', 400);
      if (body.id === sessionId) {
        return err('this_device', 'That is this device. Use Sign out to sign out here.', 400);
      }
      if (!(await signOutDevice(userId, body.id))) {
        return err('not_found', 'That device is already signed out.', 404);
      }
    } else if (body?.action === 'sign_out_others') {
      await signOutOtherDevices(userId, sessionId);
    } else if (body?.action === 'multi' && typeof body.on === 'boolean') {
      await setMultipleDevices(userId, body.on, sessionId);
    } else {
      return err('bad_request', 'Unknown action.', 400);
    }
    return NextResponse.json(await state(userId, sessionId));
  } catch (error) {
    console.error('[api/auth/devices] action failed', error);
    return err('unavailable', 'That did not go through. Try again.', 503);
  }
}

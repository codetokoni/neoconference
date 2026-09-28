// src/app/api/auth/kingschat/mobile/route.ts
//
// POST /api/auth/kingschat/mobile   { code }  ->  { ticket } | { error }
//
// KingsChat login from the Android app, the way KingsChat's mobile docs
// describe it (developers.kingschat.online/docs/mobile): the app asks the
// installed KingsChat app to authorise it (the KingsLogin SDK handshake),
// KingsChat hands back a one-time authorization code, and the app posts it
// here. We exchange it for tokens — the endpoint and body are those of
// KingsChat's own sample (KingsLogin-android, sample-extended) — and then
// sign the person in exactly as the web callback does (src/lib/kc-signin),
// answering with the Clerk ticket the app already knows how to redeem.
//
// Public in the middleware (/api/auth/kingschat/(.*)): the caller has no
// session yet. Trusting a code from a phone is safe because KingsChat
// itself redeems it, once, for the client id registered to this app's
// package and signing certificate.

import { NextResponse } from 'next/server';
import { signInWithKcTokens } from '@/lib/kc-signin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN_URL = 'https://connect.kingsch.at/developer/api/oauth2/token';

// The Android application registered on the KingsChat console (package
// app.neoconference). Not a secret: it ships inside the app.
const MOBILE_CLIENT_ID =
  process.env.KINGSCHAT_MOBILE_CLIENT_ID || '0dcd6e74-a404-4372-b399-dc2193679135';

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in_millis?: string | number;
  expires_in?: string | number;
};

export async function POST(req: Request) {
  let code = '';
  try {
    const body = (await req.json()) as { code?: unknown };
    if (typeof body?.code === 'string') code = body.code.trim();
  } catch {
    // falls through to missing_code
  }
  if (!code || code.length > 4096) {
    return NextResponse.json({ error: 'missing_code' }, { status: 400 });
  }

  let tokens: TokenResponse;
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'code', client_id: MOBILE_CLIENT_ID, code }),
      cache: 'no-store',
    });
    const text = await r.text();
    if (!r.ok) {
      // KingsChat's own words, never the code: a rejected exchange names
      // itself in the log (expired, already used, wrong client).
      console.error('[kc-mobile] token exchange failed', r.status, text.slice(0, 300));
      return NextResponse.json(
        { error: 'exchange_' + r.status, detail: text.slice(0, 200) },
        { status: 502 }
      );
    }
    tokens = JSON.parse(text) as TokenResponse;
  } catch (e) {
    console.error('[kc-mobile] token exchange threw', e);
    return NextResponse.json({ error: 'exchange_failed' }, { status: 502 });
  }

  const accessToken = tokens.access_token || '';
  if (!accessToken) {
    console.error('[kc-mobile] token exchange answered without an access token', Object.keys(tokens));
    return NextResponse.json({ error: 'missing_access_token' }, { status: 502 });
  }
  const millis = Number(tokens.expires_in_millis);
  const seconds = Number(tokens.expires_in);
  const expiresIn = millis > 0 ? Math.round(millis / 1000) : seconds > 0 ? seconds : 3600;

  const result = await signInWithKcTokens({
    accessToken,
    refreshToken: tokens.refresh_token,
    expiresIn,
    saveTokens: false,
  });
  if (!result.ok) {
    console.error('[kc-mobile] sign-in failed', result.code, result.debug);
    return NextResponse.json({ error: result.code, detail: result.debug }, { status: 502 });
  }
  return NextResponse.json({ ticket: result.ticket });
}

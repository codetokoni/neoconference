import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  NEOEMAIL_STATE_COOKIE,
  NEOEMAIL_STATE_TTL_SECONDS,
  neoemailCallbackUri,
  neoemailIssuer,
} from '@/lib/neoemailOAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// "Continue with Neoemail", step one.
//
// Unlike the KingsChat flow beside it, this is an ordinary authorization-code
// redirect, so it gets the guard that one cannot have: a `state` value, stored
// in an httpOnly cookie here and compared on the way back. Without it, anybody
// able to make the browser visit our callback with a code of their own choosing
// could sign the reader into an account that is not theirs.

export async function GET(request: Request) {
  const clientId = process.env.NEOEMAIL_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.redirect(new URL('/sign-in?ne_error=missing_client_id', request.url));
  }

  const requestUrl = new URL(request.url);

  // Same guard as the KingsChat start: relay same-origin relative paths only,
  // never an absolute or protocol-relative URL, which would make this an
  // open redirect.
  const rawRedirect = (requestUrl.searchParams.get('redirect_url') || '').trim();
  const redirectUrl =
    rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') ? rawRedirect : '';

  const callbackUri = neoemailCallbackUri(requestUrl.origin);

  const state = randomBytes(32).toString('base64url');

  const authorize = new URL(`${neoemailIssuer()}/authorize`);
  authorize.searchParams.set('client_id', clientId);
  // Registered exactly on the Neomail side, so it must match to the character.
  // The caller's destination rides in the cookie rather than on this URL.
  authorize.searchParams.set('redirect_uri', callbackUri);
  authorize.searchParams.set('state', state);

  const response = NextResponse.redirect(authorize, { status: 303 });
  response.cookies.set(NEOEMAIL_STATE_COOKIE, `${state}:${redirectUrl}`, {
    httpOnly: true,
    secure: requestUrl.protocol === 'https:',
    sameSite: 'lax', // must survive the redirect back from another origin
    path: '/',
    maxAge: NEOEMAIL_STATE_TTL_SECONDS,
  });
  return response;
}

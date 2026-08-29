import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import {
  NEOEMAIL_STATE_COOKIE,
  neoemailCallbackUri,
  neoemailIssuer,
  readStateCookie,
} from '@/lib/neoemailOAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// "Continue with Neoemail", step two.
//
// Verifies the state, exchanges the code for an identity server-to-server, then
// lands in exactly the same place the KingsChat callback does: a Clerk user
// found or created by externalId, and a short-lived sign-in ticket handed to
// /sign-in. Everything after that point is Clerk's, unchanged.

function errorRedirect(request: Request, code: string, redirectUrl: string, debug?: string) {
  const url = new URL('/sign-in', request.url);
  url.searchParams.set('ne_error', code);
  if (debug) url.searchParams.set('ne_debug', debug.slice(0, 300));
  if (redirectUrl && redirectUrl !== '/') url.searchParams.set('redirect_url', redirectUrl);

  const response = NextResponse.redirect(url, { status: 303 });
  // The state is single-use whatever happened, so a failed attempt cannot leave
  // a value behind for a later forged callback to match against.
  response.cookies.set(NEOEMAIL_STATE_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}

/** Constant-time, because a state compared byte by byte can be discovered. */
function stateMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();
  const presentedState = (url.searchParams.get('state') || '').trim();

  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${NEOEMAIL_STATE_COOKIE}=`))
    ?.slice(NEOEMAIL_STATE_COOKIE.length + 1);

  const { state: expectedState, redirectUrl } = readStateCookie(cookie);

  // Checked before anything else is read. A callback without a matching state
  // is not a failed sign-in, it is somebody else's request.
  if (!expectedState || !stateMatches(expectedState, presentedState)) {
    return errorRedirect(request, 'state_mismatch', redirectUrl);
  }
  if (!code) return errorRedirect(request, 'missing_code', redirectUrl);

  const clientId = process.env.NEOEMAIL_CLIENT_ID?.trim();
  const clientSecret = process.env.NEOEMAIL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return errorRedirect(request, 'not_configured', redirectUrl);
  }

  const callbackUri = neoemailCallbackUri(url.origin);

  let identity: { sub?: string; email?: string; name?: string };
  try {
    // Server to server: the secret never reaches the browser, which is the
    // whole reason the code is worth nothing on its own.
    const response = await fetch(`${neoemailIssuer()}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUri,
      }),
      cache: 'no-store',
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error('[neoemail-callback] token exchange failed', response.status, body.slice(0, 300));
      return errorRedirect(request, `exchange_${response.status}`, redirectUrl);
    }
    identity = await response.json();
  } catch (error) {
    console.error('[neoemail-callback] token exchange threw', error);
    return errorRedirect(request, 'exchange_failed', redirectUrl);
  }

  const sub = String(identity.sub || '').trim();
  const email = String(identity.email || '').trim();
  if (!sub || !email) return errorRedirect(request, 'incomplete_identity', redirectUrl);

  // Namespaced the same way the KingsChat flow namespaces its ids, so the two
  // can never collide on one Clerk account.
  const externalId = `neomail:${sub}`;
  const name = String(identity.name || '').trim();
  const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);

  const cc = await clerkClient();
  let userId = '';

  try {
    const byExternal = await cc.users.getUserList({ externalId: [externalId], limit: 1 });
    if (byExternal.data?.length) userId = byExternal.data[0].id;
  } catch {
    // Falls through to the lookups below.
  }

  if (!userId) {
    try {
      const byEmail = await cc.users.getUserList({ emailAddress: [email], limit: 1 });
      if (byEmail.data?.length) {
        const existing = byEmail.data[0];
        // Linking rather than creating a second account: the address is the
        // same person, and Neomail verified it by signing them in.
        await cc.users.updateUser(existing.id, {
          externalId,
          publicMetadata: {
            ...(existing.publicMetadata || {}),
            neoemail: { sub, email, linkedAt: new Date().toISOString() },
          },
        } as never);
        userId = existing.id;
      }
    } catch (error) {
      console.error('[neoemail-callback] link failed', error);
      return errorRedirect(request, 'link_failed', redirectUrl);
    }
  }

  if (!userId) {
    try {
      const created = await cc.users.createUser({
        externalId,
        emailAddress: [email],
        firstName: firstName || undefined,
        lastName: rest.length ? rest.join(' ') : undefined,
        skipPasswordRequirement: true,
        publicMetadata: { neoemail: { sub, email } },
      } as never);
      userId = created.id;
    } catch (error) {
      console.error('[neoemail-callback] createUser failed', error);
      return errorRedirect(request, 'create_failed', redirectUrl);
    }
  }

  let ticket = '';
  try {
    const result = await (
      cc as unknown as {
        signInTokens: {
          createSignInToken(input: { userId: string; expiresInSeconds: number }): Promise<{ token?: string }>;
        };
      }
    ).signInTokens.createSignInToken({ userId, expiresInSeconds: 60 });
    ticket = result?.token || '';
  } catch (error) {
    console.error('[neoemail-callback] signInToken failed', error);
    return errorRedirect(request, 'ticket_failed', redirectUrl);
  }
  if (!ticket) return errorRedirect(request, 'ticket_failed', redirectUrl);

  const destination = new URL('/sign-in', request.url);
  destination.searchParams.set('__clerk_ticket', ticket);
  if (redirectUrl && redirectUrl !== '/') destination.searchParams.set('redirect_url', redirectUrl);

  const response = NextResponse.redirect(destination, { status: 303 });
  // Spent. One state, one sign-in.
  response.cookies.set(NEOEMAIL_STATE_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}

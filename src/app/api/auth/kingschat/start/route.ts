import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// KingsChat OAuth start.
// KC uses a non-standard flow: it POSTs the user fields directly to redirect_uri.
// Params: client_id, scopes (JSON array string), post_redirect=true, redirect_uri.
export async function GET(request: Request) {
  const clientId = process.env.KINGSCHAT_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(new URL('/sign-in?kc_error=missing_client_id', request.url));
  }

  const requestUrl = new URL(request.url);
  const origin = requestUrl.origin;

  // FRS §9.4: relay the caller's original destination through the KC round
  // trip. KC has no state parameter, so we smuggle it as a query on the
  // callback URL — it comes back to us on the callback request URL, and the
  // callback forwards it into /sign-in?redirect_url=...
  const rawRedirect = (requestUrl.searchParams.get('redirect_url') || '').trim();
  // Only relay same-origin relative paths — no absolute URLs, no protocol-
  // relative (//host) URLs. Prevents this becoming an open-redirect vector.
  const redirectUrl = rawRedirect.startsWith('/') && !rawRedirect.startsWith('//')
    ? rawRedirect
    : '';

  const callbackBase = process.env.KINGSCHAT_REDIRECT_URI || (origin + '/api/auth/kingschat/callback');
  const redirectUri = redirectUrl
    ? `${callbackBase}${callbackBase.includes('?') ? '&' : '?'}redirect_url=${encodeURIComponent(redirectUrl)}`
    : callbackBase;

  const params = new URLSearchParams({
    client_id: clientId,
    scopes: JSON.stringify(['send_chat_message']),
    post_redirect: 'true',
    redirect_uri: redirectUri,
  });

  const authUrl = 'https://accounts.kingsch.at/?' + params.toString();
  return NextResponse.redirect(authUrl);
}

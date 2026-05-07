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

  const origin = new URL(request.url).origin;
  const redirectUri = process.env.KINGSCHAT_REDIRECT_URI || (origin + '/api/auth/kingschat/callback');

  const params = new URLSearchParams({
    client_id: clientId,
    scopes: JSON.stringify(['send_chat_message']),
    post_redirect: 'true',
    redirect_uri: redirectUri,
  });

  const authUrl = 'https://accounts.kingsch.at/?' + params.toString();
  return NextResponse.redirect(authUrl);
}

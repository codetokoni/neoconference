import { NextResponse } from 'next/server';
import { flatten, pick, signInWithKcTokens } from '@/lib/kc-signin';
import { isAppCallback, redirectToApp, safeRelay } from '@/lib/app-callback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// KingsChat OAuth callback.
// KC posts {accessToken, refreshToken} as form-urlencoded to this URL (post_redirect=true flow).
// We then GET https://connect.kingsch.at/developer/api/profile with Bearer accessToken to get the user.


function safeRelayRedirect(req: Request): string {
  // Only relay same-origin relative paths or the app's deep link, matching
  // the guard in /start.
  return safeRelay(new URL(req.url).searchParams.get('redirect_url'));
}

function errorRedirect(req: Request, code: string, debug?: string) {
  if (isAppCallback(safeRelayRedirect(req))) {
    return redirectToApp({ kc_error: code });
  }
  const url = new URL('/sign-in', req.url);
  url.searchParams.set('kc_error', code);
  if (debug) url.searchParams.set('kc_debug', debug.slice(0, 500));
  const relay = safeRelayRedirect(req);
  if (relay && relay !== '/') url.searchParams.set('redirect_url', relay);
  return NextResponse.redirect(url, { status: 303 });
}


async function readBody(req: Request): Promise<{raw: string; data: Record<string, unknown>; ct: string}> {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  const raw = await req.text();
  let data: Record<string, unknown> = {};
  if (ct.includes('application/json')) {
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  } else if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data') || raw.includes('=')) {
    try {
      const params = new URLSearchParams(raw);
      const out: Record<string, unknown> = {};
      for (const [k, v] of params.entries()) {
        if (v.startsWith('{') || v.startsWith('[')) {
          try { out[k] = JSON.parse(v); continue; } catch {}
        }
        out[k] = v;
      }
      data = out;
    } catch { data = {}; }
  } else {
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  }
  return { raw, data, ct };
}

async function handle(req: Request) {
  const { raw, data, ct } = await readBody(req);

  try {
    console.log('[kc-callback] method=' + req.method + ' ct=' + ct + ' raw-length=' + raw.length);
    console.log('[kc-callback] keys=' + Object.keys(data).join(','));
  } catch {}

  const flat = flatten(data);
  const accessToken = pick(flat, ['accesstoken', 'access_token']);
  // Refresh token is emitted alongside the access token when
  // send_chat_message scope is requested (that's already how we
  // configure the OAuth start). It's the only way to keep messaging a
  // user after their access token expires; we persist it to KV
  // downstream so the server-side sender can refresh silently.
  const refreshToken = pick(flat, ['refreshtoken', 'refresh_token']);
  // KC's token payload usually carries an expires_in (seconds until
  // expiry). Some versions omit it and expect ~1 hour lifetimes.
  const expiresInRaw = pick(flat, ['expiresin', 'expires_in']);
  const expiresIn = Number(expiresInRaw) > 0 ? Number(expiresInRaw) : 3600;

  if (!accessToken) {
    const debug = 'no-access-token|ct=' + ct + '|keys=' + Object.keys(flat).slice(0, 20).join(',');
    return errorRedirect(req, 'missing_access_token', debug);
  }

  // Everything from here — the profile, the account, the stored tokens,
  // the ticket — is shared with the mobile route (src/lib/kc-signin.ts).
  const result = await signInWithKcTokens({
    accessToken,
    refreshToken: refreshToken || undefined,
    expiresIn,
  });
  if (!result.ok) return errorRedirect(req, result.code, result.debug);
  const ticket = result.ticket;

  const relay = safeRelayRedirect(req);
  // The mobile app redeems the ticket itself; see lib/app-callback.
  if (isAppCallback(relay)) return redirectToApp({ __clerk_ticket: ticket });

  const dest = new URL('/sign-in', req.url);
  dest.searchParams.set('__clerk_ticket', ticket);
  if (relay && relay !== '/') dest.searchParams.set('redirect_url', relay);
  return NextResponse.redirect(dest, { status: 303 });
}

export async function POST(req: Request) { return handle(req); }
export async function GET(req: Request) { return handle(req); }
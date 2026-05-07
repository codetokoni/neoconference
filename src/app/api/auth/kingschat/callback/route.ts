import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// KingsChat OAuth callback.
// KC posts user data directly to this URL (post_redirect=true flow).
// Body may be application/x-www-form-urlencoded or application/json.
// Field names vary, so we try multiple keys, walk nested objects, and case-insensitively match.

function errorRedirect(req: Request, code: string, debug?: string) {
  const url = new URL('/sign-in', req.url);
  url.searchParams.set('kc_error', code);
  if (debug) url.searchParams.set('kc_debug', debug.slice(0, 500));
  return NextResponse.redirect(url, { status: 303 });
}

// Walk an arbitrarily nested object collecting every primitive leaf into a flat map keyed by leaf name (lowercased).
function flatten(obj: unknown, out: Record<string, string> = {}, depth = 0): Record<string, string> {
  if (depth > 4 || obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach(v => flatten(v, out, depth + 1));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        flatten(v, out, depth + 1);
      } else if (v !== undefined && v !== null && String(v).length > 0) {
        out[k.toLowerCase()] = String(v);
      }
    }
  }
  return out;
}

function pick(flat: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    const v = flat[k.toLowerCase()];
    if (v) return v;
  }
  return '';
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
        // try to JSON-parse values that look like objects
        if (v.startsWith('{') || v.startsWith('[')) {
          try { out[k] = JSON.parse(v); continue; } catch { /* fallthrough */ }
        }
        out[k] = v;
      }
      data = out;
    } catch { data = {}; }
  } else {
    // Try JSON as a last resort
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  }
  return { raw, data, ct };
}

async function handle(req: Request) {
  const { raw, data, ct } = await readBody(req);

  // Log to Vercel
  try {
    console.log('[kc-callback] method=' + req.method + ' content-type=' + ct + ' raw-length=' + raw.length);
    console.log('[kc-callback] raw=' + raw.slice(0, 2000));
    console.log('[kc-callback] parsed-keys=' + Object.keys(data).join(','));
  } catch { /* ignore */ }

  // Flatten everything into one keyspace
  const flat = flatten(data);

  const kcId = pick(flat, [
    'id', 'userid', 'user_id', 'kingschatid', 'kingschat_id',
    'kcid', 'kc_id', 'sub', 'kingschatuserid', 'profileid'
  ]);
  const kcUsername = pick(flat, [
    'username', 'user_name', 'handle', 'kc_username', 'kingschatusername', 'name'
  ]);
  const firstName = pick(flat, ['firstname', 'first_name', 'givenname', 'given_name']);
  const lastName  = pick(flat, ['lastname', 'last_name', 'familyname', 'family_name', 'surname']);
  const email     = pick(flat, ['email', 'emailaddress', 'email_address', 'mail']);

  if (!kcId) {
    // Build a debug string of available keys so we can iterate from the URL
    const debug = 'ct=' + ct + '|keys=' + Object.keys(flat).slice(0, 20).join(',');
    return errorRedirect(req, 'missing_kc_user', debug);
  }

  const externalId = 'kc:' + kcId;
  const cc = await clerkClient();

  let user = null as null | { id: string };
  try {
    const list = await cc.users.getUserList({ externalId: [externalId], limit: 1 });
    if (list.data && list.data.length > 0) user = list.data[0];
  } catch { /* continue */ }

  if (!user && email) {
    try {
      const list = await cc.users.getUserList({ emailAddress: [email], limit: 1 });
      if (list.data && list.data.length > 0) {
        return errorRedirect(req, 'email_already_registered');
      }
    } catch { /* continue */ }
  }

  if (!user) {
    try {
      const created = await cc.users.createUser({
        externalId,
        emailAddress: email ? [email] : undefined,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        username: kcUsername || undefined,
        skipPasswordRequirement: true,
        publicMetadata: { kingschat: { id: kcId, username: kcUsername } },
      } as any);
      user = { id: created.id };
    } catch (e) {
      console.error('[kc-callback] createUser failed', e);
      return errorRedirect(req, 'create_failed');
    }
  } else {
    try {
      await cc.users.updateUser(user.id, {
        publicMetadata: { kingschat: { id: kcId, username: kcUsername } },
      } as any);
    } catch { /* non-fatal */ }
  }

  let ticket = '';
  try {
    const res = await (cc as any).signInTokens.createSignInToken({
      userId: user!.id,
      expiresInSeconds: 60,
    });
    ticket = res?.token || '';
  } catch (e) {
    console.error('[kc-callback] signInToken failed', e);
    return errorRedirect(req, 'ticket_failed');
  }
  if (!ticket) return errorRedirect(req, 'ticket_failed');

  const dest = new URL('/sign-in', req.url);
  dest.searchParams.set('__clerk_ticket', ticket);
  return NextResponse.redirect(dest, { status: 303 });
}

export async function POST(req: Request) { return handle(req); }
export async function GET(req: Request) { return handle(req); }


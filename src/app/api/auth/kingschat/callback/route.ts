import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// KingsChat OAuth callback.
// KC posts user data directly to this URL (post_redirect=true flow).
// Body may be application/x-www-form-urlencoded or application/json.
// User fields may be flat or nested under 'user'. Field names vary, so we try multiple keys.

function errorRedirect(req: Request, code: string) {
  const url = new URL('/sign-in', req.url);
  url.searchParams.set('kc_error', code);
  return NextResponse.redirect(url, { status: 303 });
}

function pick(data: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = data[k];
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  return '';
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return (await req.json()) || {}; } catch { return {}; }
  }
  // default: form-urlencoded (also works for multipart-ish via formData)
  try {
    const fd = await req.formData();
    const out: Record<string, unknown> = {};
    fd.forEach((v, k) => { out[k] = typeof v === 'string' ? v : String(v); });
    return out;
  } catch {
    return {};
  }
}

async function handle(req: Request) {
  const raw = await readBody(req);

  // user data may be nested under 'user'
  const userObj = (raw.user && typeof raw.user === 'object') ? raw.user as Record<string, unknown> : raw;

  const kcId       = pick(userObj, ['id', 'userId', 'user_id', 'kingschatId', 'kingschat_id']);
  const kcUsername = pick(userObj, ['username', 'userName', 'user_name', 'handle']);
  const firstName  = pick(userObj, ['firstName', 'first_name', 'givenName']);
  const lastName   = pick(userObj, ['lastName', 'last_name', 'familyName', 'surname']);
  const email      = pick(userObj, ['email', 'emailAddress', 'email_address']);

  if (!kcId) {
    return errorRedirect(req, 'missing_kc_user');
  }

  const externalId = 'kc:' + kcId;
  const cc = await clerkClient();

  // 1) lookup by externalId
  let user = null as null | { id: string };
  try {
    const list = await cc.users.getUserList({ externalId: [externalId], limit: 1 });
    if (list.data && list.data.length > 0) user = list.data[0];
  } catch { /* continue */ }

  // 2) fallback by email
  if (!user && email) {
    try {
      const list = await cc.users.getUserList({ emailAddress: [email], limit: 1 });
      if (list.data && list.data.length > 0) {
        // Email already on a different account: block per policy C
        return errorRedirect(req, 'email_already_registered');
      }
    } catch { /* continue */ }
  }

  // 3) create user if not found
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
      console.error('[kc] createUser failed', e);
      return errorRedirect(req, 'create_failed');
    }
  } else {
    // refresh metadata for returning users
    try {
      await cc.users.updateUser(user.id, {
        publicMetadata: { kingschat: { id: kcId, username: kcUsername } },
      } as any);
    } catch { /* non-fatal */ }
  }

  // 4) mint sign-in ticket
  let ticket = '';
  try {
    const res = await (cc as any).signInTokens.createSignInToken({
      userId: user!.id,
      expiresInSeconds: 60,
    });
    ticket = res?.token || '';
  } catch (e) {
    console.error('[kc] signInToken failed', e);
    return errorRedirect(req, 'ticket_failed');
  }
  if (!ticket) return errorRedirect(req, 'ticket_failed');

  const dest = new URL('/sign-in', req.url);
  dest.searchParams.set('__clerk_ticket', ticket);
  return NextResponse.redirect(dest, { status: 303 });
}

export async function POST(req: Request) { return handle(req); }
// Some KC setups may GET; support both, just in case
export async function GET(req: Request) { return handle(req); }

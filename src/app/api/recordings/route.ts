import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { isR2Configured, listRecordings, signGetUrl, deleteObject, renameObject } from '@/lib/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sanitize a path segment the same way egress/start/route.ts does, so the
// user prefix we compute here matches the prefix that was used when the
// recording was actually written.
function sanitizeSegment(s: string): string {
  return (s || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'x';
}

function userPrefix(userId: string): string {
  return 'recordings/' + sanitizeSegment(userId) + '/';
}

/**
 * GET /api/recordings
 *
 * Lists ONLY the authenticated user's recordings from R2 and signs a fresh
 * download URL for each (1 hour expiry).
 *
 * Notes:
 *  - Per-user scoping is enforced server-side: we always list with the
 *    'recordings/<userId>/' prefix and ignore any client-supplied prefix
 *    except as an optional sub-filter under that namespace.
 *  - Files written before per-user namespacing (i.e. legacy 'recordings/<room>/...')
 *    are intentionally NOT returned to any user — they predate ownership info.
 *
 * Query params:
 *  subPrefix?: string  optional further filter under the user's namespace,
 *                      e.g. room slug. Slashes are allowed.
 *  max?:      number   default 100, max 500.
 */
export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  if (!isR2Configured()) {
    return NextResponse.json({
      ok: true,
      configured: false,
      recordings: [],
      hint: 'R2/S3 env vars not set (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY).',
    });
  }

  const url = new URL(req.url);
  // Accept legacy 'prefix' param but treat it as a sub-filter under the user's
  // namespace; never let a client list outside their own prefix.
  const rawSub = url.searchParams.get('subPrefix') || url.searchParams.get('prefix') || '';
  const sub = rawSub.replace(/^\/+/, '');
  const base = userPrefix(userId);
  // If the caller already passed the full user prefix, don't double it.
  const effectivePrefix = sub.startsWith(base) ? sub : base + sub;
  const max = Math.min(
    Math.max(parseInt(url.searchParams.get('max') || '100', 10) || 100, 1),
    500
  );

  try {
    const items = await listRecordings(effectivePrefix, max);
    const recordings = await Promise.all(
      items
        .filter((o) => o.size > 0)
        // Defense in depth: even if the listing somehow returned objects
        // outside the user's prefix, drop them before exposing to the client.
        .filter((o) => o.key.startsWith(base))
        .map(async (o) => ({
          key: o.key,
          size: o.size,
          lastModified: o.lastModified,
          downloadUrl: await signGetUrl(o.key, 3600),
        }))
    );

    return NextResponse.json({ ok: true, configured: true, recordings });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}

/**
 * DELETE /api/recordings?key=<r2-object-key>
 *
 * Permanently removes a recording object from R2. The key MUST live inside
 * the authenticated user's prefix; anything else is rejected (403).
 */
export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ ok: false, error: 'r2-not-configured' }, { status: 503 });
  }
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key || key.length > 512) {
    return NextResponse.json({ ok: false, error: 'missing-or-invalid-key' }, { status: 400 });
  }
  if (!key.startsWith(userPrefix(userId))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  try {
    await deleteObject(key);
    return NextResponse.json({ ok: true, key });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'delete-failed' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/recordings
 *
 * Body: { key: string, newKey: string }
 * Renames an R2 object by copying then deleting the original.
 * Both old and new keys MUST live inside the authenticated user's prefix.
 */
export async function PATCH(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ ok: false, error: 'r2-not-configured' }, { status: 503 });
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 }); }
  const key = typeof body?.key === 'string' ? body.key : '';
  const newKey = typeof body?.newKey === 'string' ? body.newKey : '';
  if (!key || !newKey || key === newKey || key.length > 512 || newKey.length > 512) {
    return NextResponse.json({ ok: false, error: 'missing-or-invalid-keys' }, { status: 400 });
  }
  // Constrain newKey to safe chars.
  if (!/^[A-Za-z0-9._\/\-]+$/.test(newKey)) {
    return NextResponse.json({ ok: false, error: 'invalid-newKey-chars' }, { status: 400 });
  }
  const base = userPrefix(userId);
  if (!key.startsWith(base) || !newKey.startsWith(base)) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  try {
    await renameObject(key, newKey);
    return NextResponse.json({ ok: true, key, newKey });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'rename-failed' }, { status: 500 });
  }
}

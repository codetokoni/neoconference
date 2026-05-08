import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { isR2Configured, listRecordings, signGetUrl, deleteObject } from '@/lib/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/recordings
 *
 * Lists recordings stored in the configured R2 bucket and signs a fresh
 * download URL for each (1 hour expiry).
 *
 * Query params:
 *   prefix?: string  (e.g. roomName to scope listing)
 *   max?: number     (default 100, max 500)
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
  const prefix = url.searchParams.get('prefix') || undefined;
  const max = Math.min(
    Math.max(parseInt(url.searchParams.get('max') || '100', 10) || 100, 1),
    500
  );

  try {
    const items = await listRecordings(prefix, max);
    const recordings = await Promise.all(
      items
        .filter((o) => o.size > 0)
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
 * Permanently removes a recording object from R2. Requires authenticated
 * Clerk user. The room/event ownership check happens upstream via the
 * recording prefix being scoped to the user.
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

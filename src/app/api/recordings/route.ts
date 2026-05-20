import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { isR2Configured, listRecordings, signGetUrl, deleteObject, renameObject } from '@/lib/r2';
import { transcribeStore } from '@/lib/transcribeStore';

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

// LiveKit egress writes audio sidecars as "<basename>.m4a.mp4" (and older
// runs may have produced bare "<basename>.m4a"). Treat both as audio so the
// dashboard can pair them with their video sibling instead of listing them
// as separate, untranscribable video rows.
function isAudioKey(k: string): boolean {
    return /\.m4a(?:\.mp4)?$/i.test(k);
}

function stripAudioExt(k: string): string {
    return k.replace(/\.m4a(?:\.mp4)?$/i, '');
}

/**
 * GET /api/recordings
 *
 * Lists ONLY the authenticated user's recordings from R2 and signs a fresh
 * download URL for each (1 hour expiry). Also enriches each recording with
 * its transcript (and AI summary) when one exists in the transcribeStore.
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
    const rawSub = url.searchParams.get('subPrefix') || url.searchParams.get('prefix') || '';
    const sub = rawSub.replace(/^\/+/, '');
    const base = userPrefix(userId);
    const effectivePrefix = sub.startsWith(base) ? sub : base + sub;
    const max = Math.min(
          Math.max(parseInt(url.searchParams.get('max') || '100', 10) || 100, 1),
          500
        );

  try {
        const items = await listRecordings(effectivePrefix, max);
        const filtered = items
          .filter((o) => o.size > 0)
          .filter((o) => o.key.startsWith(base));

      // Pair each .mp4 video with its audio sidecar (same basename). Sidecars
      // may be named "<basename>.m4a" OR "<basename>.m4a.mp4" depending on the
      // egress preset, so we strip both forms when building the lookup. Audio
      // sidecars are also excluded from the videos list so they don't surface
      // as standalone rows in the dashboard.
      const videos = filtered.filter(
              (o) => /\.mp4$/i.test(o.key) && !isAudioKey(o.key)
            );
        const audioByBase = new Map<string, { key: string; size: number }>();
        for (const o of filtered) {
                if (!isAudioKey(o.key)) continue;
                audioByBase.set(stripAudioExt(o.key), { key: o.key, size: o.size });
        }

      // Look up persisted transcripts in one parallel batch keyed by recordingKey.
      const keys = videos.map((o) => o.key);
        const jobsByKey = await transcribeStore.getByRecordingKeys(keys);

      const recordings = await Promise.all(
              videos.map(async (o) => {
                        const job = jobsByKey.get(o.key);
                        const baseNoExt = o.key.slice(0, -4);
                        const audioMatch = audioByBase.get(baseNoExt);
                        return {
                                    key: o.key,
                                    size: o.size,
                                    lastModified: o.lastModified,
                                    downloadUrl: await signGetUrl(o.key, 3600),
                                    audio: audioMatch
                                      ? {
                                                        key: audioMatch.key,
                                                        size: audioMatch.size,
                                                        downloadUrl: await signGetUrl(audioMatch.key, 3600),
                                      }
                                                  : null,
                                    transcript: job
                                      ? {
                                                        jobId: job.id,
                                                        status: job.status,
                                                        provider: job.provider,
                                                        text: job.text,
                                                        summary: job.summary,
                                                        error: job.error,
                                                        updatedAt: job.updatedAt,
                                      }
                                                  : null,
                        };
              })
            );

      return NextResponse.json({ ok: true, configured: true, recordings });
  } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}

/**
 * DELETE /api/recordings?key=<r2-object-key>
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

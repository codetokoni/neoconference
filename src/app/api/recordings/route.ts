import { errorMessage } from "@/lib/errorMessage";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { isR2Configured, listRecordings, signGetUrl, deleteObject, renameObject } from '@/lib/r2';
import { transcribeStore } from '@/lib/transcribeStore';
import { tryMoveToTrash } from '@/lib/dataGov/trash';
import { asReported } from '@/lib/transcribeNotSetUp';
import { eventStore } from '@/lib/eventStore';
import { authorize } from '@/lib/authz';
import {
  isAudioKey,
  listEventRecordingObjects,
  stripAudioExt,
  userPrefix,
} from '@/lib/eventRecordings';
import { indexDeleted, indexRenamed, indexTrashed, trashedKeys } from '@/lib/content/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/recordings
 *
 * Two modes:
 *
 *   Default (no eventSlug) — returns ONLY the authenticated user's recordings
 *   from R2. The dashboard recordings page uses this.
 *
 *   eventSlug=<slug> — FRS §2: recordings scoped by event role. Loads the
 *   event, authorizes recording:read (RANK.host), then unions recordings
 *   under every elevated participant's R2 prefix so Owner+Host see every
 *   recording of the meeting regardless of who initiated it.
 *
 * Enriches each row with a signed download URL (1 h expiry), its audio
 * sidecar if paired, and its transcript / AI summary when one exists.
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
    const eventSlug = url.searchParams.get('eventSlug') || '';
    const max = Math.min(
          Math.max(parseInt(url.searchParams.get('max') || '100', 10) || 100, 1),
          500
        );

  try {
        let filtered: Array<{ key: string; size: number; lastModified?: string }>;

        if (eventSlug) {
              // Event-scoped mode (FRS §2). Authorize on the event, then union
              // across every plausible R2 prefix a host might have written to.
              const ev = await eventStore.bySlug(eventSlug);
              if (!ev) return NextResponse.json({ ok: false, error: 'event_not_found' }, { status: 404 });
              const gate = await authorize(ev, 'recording:read');
              if (!gate.ok) return gate.response;

              // Shared with the meeting summary (lib/eventRecordings).
              filtered = await listEventRecordingObjects(ev, max, eventSlug);
        } else {
              // Default mode — caller's own recordings only.
              const base = userPrefix(userId);
              const effectivePrefix = sub.startsWith(base) ? sub : base + sub;
              const items = await listRecordings(effectivePrefix, max);
              filtered = items
                .filter((o) => o.size > 0)
                .filter((o) => o.key.startsWith(base));
        }

      // Files an administrator moved to the trash are not listed.
      const trashed = await trashedKeys(filtered.map((o) => o.key));
      if (trashed.size) filtered = filtered.filter((o) => !trashed.has(o.key));

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
                        const stored = jobsByKey.get(o.key);
                        const job = stored ? asReported(stored) : undefined;
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
          // Moved under trash/ rather than deleted, so an administrator can
          // restore it for the trash period (src/lib/dataGov/trash.ts). It
          // leaves the user's list at once, as before. If the move fails the
          // file is deleted outright, as it always was.
          const kept = await tryMoveToTrash({
            kind: 'recording',
            label: key.split('/').pop() || key,
            ownerId: userId,
            ref: key,
            deletedBy: userId,
            r2Keys: [key],
          });
          if (!kept) await deleteObject(key);
          // The admin file index (Content): in the trash, or gone.
          if (kept) await indexTrashed(key, kept.id, userId);
          else await indexDeleted(key);
          return NextResponse.json({ ok: true, key });
    } catch (e) {
          return NextResponse.json(
            { ok: false, error: errorMessage(e) || 'delete-failed' },
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
    let body: Record<string, unknown> = {};
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
          await indexRenamed(key, newKey);
          return NextResponse.json({ ok: true, key, newKey });
    } catch (e) {
          return NextResponse.json({ ok: false, error: errorMessage(e) || 'rename-failed' }, { status: 500 });
    }
}

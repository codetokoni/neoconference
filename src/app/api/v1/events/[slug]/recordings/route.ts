import { NextRequest } from 'next/server';
import { requireApiKey, ApiError } from '@/lib/apiAuth';
import { apiSuccess, apiFailure } from '@/lib/apiResponse';
import { eventStore } from '@/lib/eventStore';
import { listEventRecordingObjects } from '@/lib/eventRecordings';
import { signGetUrl } from '@/lib/r2';
import { apiRecordings } from '@/lib/apiShapes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/events/:slug/recordings
 * Recordings of one of the key owner's events, made with Record on the
 * website, with download links that work for an hour. Whoever pressed
 * Record (owner or a host), and under every name the event has had.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string } }
) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const ev = await eventStore.bySlug(params.slug);
    if (!ev || ev.ownerUserId !== ctx.key.ownerUserId) {
      throw new ApiError(404, 'not_found', 'Event not found.');
    }
    const slugs = Array.from(new Set([ev.slug, ...(ev.aliasSlugs || [])]));
    const listed = await Promise.all(slugs.map((s) => listEventRecordingObjects(ev, 200, s)));
    const byKey = new Map(listed.flat().map((o) => [o.key, o]));
    return apiSuccess(await apiRecordings(Array.from(byKey.values()), signGetUrl), rate);
  } catch (err) {
    return apiFailure(err);
  }
}

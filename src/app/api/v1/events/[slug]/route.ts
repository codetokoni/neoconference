import { NextRequest } from 'next/server';
import { requireApiKey, ApiError } from '@/lib/apiAuth';
import { apiSuccess, apiFailure } from '@/lib/apiResponse';
import { eventStore } from '@/lib/eventStore';
import { apiEvent } from '@/lib/apiShapes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/events/:slug
 * One of the key owner's events. A renamed event is still found by its old
 * slug. Anyone else's answers 404, as one that doesn't exist does.
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
    return apiSuccess(apiEvent(ev), rate);
  } catch (err) {
    return apiFailure(err);
  }
}

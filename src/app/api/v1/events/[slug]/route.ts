import { NextRequest } from 'next/server';
import { requireApiKey, ApiError } from '@/lib/apiAuth';
import { apiSuccess, apiFailure } from '@/lib/apiResponse';
import { getEvent } from '@/lib/ncService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/events/:slug
 * Retrieve a single event and its replay status.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string } }
) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const event = await getEvent(params.slug);
    if (!event || event.ownerUserId !== ctx.key.ownerUserId) {
      throw new ApiError(404, 'not_found', 'Event not found.');
    }
    return apiSuccess(
      {
        slug: event.slug,
        title: event.title,
        visibility: event.visibility,
        createdAt: event.createdAt,
        replayReady: event.replayReady,
        replayUrl: event.replayReady
          ? `https://www.neoconference.app/e/${event.slug}/replay`
          : null,
      },
      rate
    );
  } catch (err) {
    return apiFailure(err);
  }
}

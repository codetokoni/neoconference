import { NextRequest } from 'next/server';
import { requireApiKey } from '@/lib/apiAuth';
import { apiSuccess, apiFailure } from '@/lib/apiResponse';
import { listEvents } from '@/lib/ncService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/events
 * List events owned by the API key holder, including replay availability.
 */
export async function GET(req: NextRequest) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const events = await listEvents(ctx.key.ownerUserId);
    const shaped = events.map((e) => ({
      slug: e.slug,
      title: e.title,
      visibility: e.visibility,
      createdAt: e.createdAt,
      replayReady: e.replayReady,
      replayUrl: e.replayReady ? `https://www.neoconference.app/e/${e.slug}/replay` : null,
    }));
    return apiSuccess(shaped, rate);
  } catch (err) {
    return apiFailure(err);
  }
}

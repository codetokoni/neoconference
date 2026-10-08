import { NextRequest } from 'next/server';
import { requireApiKey } from '@/lib/apiAuth';
import { apiSuccess, apiFailure } from '@/lib/apiResponse';
import { eventStore } from '@/lib/eventStore';
import { apiEvent } from '@/lib/apiShapes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/events
 * The key owner's events — the meetings they made on neoconference.app —
 * newest first. The same list the dashboard shows (eventStore).
 */
export async function GET(req: NextRequest) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const events = await eventStore.listReachableByOwner(ctx.key.ownerUserId);
    events.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return apiSuccess(events.map(apiEvent), rate);
  } catch (err) {
    return apiFailure(err);
  }
}

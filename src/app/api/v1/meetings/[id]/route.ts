import { NextRequest } from 'next/server';
import { requireApiKey, ApiError } from '@/lib/apiAuth';
import { apiSuccess, apiFailure } from '@/lib/apiResponse';
import { getMeeting, endMeeting } from '@/lib/ncService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/meetings/:id
 * Retrieve a single meeting owned by the caller.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const meeting = await getMeeting(params.id);
    if (!meeting || meeting.ownerUserId !== ctx.key.ownerUserId) {
      throw new ApiError(404, 'not_found', 'Meeting not found.');
    }
    return apiSuccess(meeting, rate);
  } catch (err) {
    return apiFailure(err);
  }
}

/**
 * DELETE /api/v1/meetings/:id
 * End a meeting: closes the LiveKit room and marks it ended.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const existing = await getMeeting(params.id);
    if (!existing || existing.ownerUserId !== ctx.key.ownerUserId) {
      throw new ApiError(404, 'not_found', 'Meeting not found.');
    }
    const ended = await endMeeting(params.id);
    return apiSuccess(ended, rate);
  } catch (err) {
    return apiFailure(err);
  }
}

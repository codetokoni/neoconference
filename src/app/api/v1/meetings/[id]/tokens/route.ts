import { NextRequest } from 'next/server';
import { requireApiKey, ApiError } from '@/lib/apiAuth';
import { apiSuccess, apiFailure, parseJson } from '@/lib/apiResponse';
import { getMeeting, createJoinToken } from '@/lib/ncService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/meetings/:id/tokens
 * Mint a short-lived LiveKit join token for a guest of this meeting.
 * Body: { identity: string, displayName?: string, canPublish?: boolean }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const meeting = await getMeeting(params.id);
    if (!meeting || meeting.ownerUserId !== ctx.key.ownerUserId) {
      throw new ApiError(404, 'not_found', 'Meeting not found.');
    }
    if (meeting.status === 'ended') {
      throw new ApiError(409, 'meeting_ended', 'This meeting has already ended.');
    }

    const body = await parseJson<{
      identity?: string;
      displayName?: string;
      canPublish?: boolean;
    }>(req);

    if (!body.identity || typeof body.identity !== 'string') {
      throw new ApiError(400, 'invalid_request', 'Field "identity" is required.');
    }

    const result = await createJoinToken({
      meeting,
      identity: body.identity,
      displayName: body.displayName,
      canPublish: body.canPublish,
    });

    return apiSuccess(result, rate, 201);
  } catch (err) {
    return apiFailure(err);
  }
}

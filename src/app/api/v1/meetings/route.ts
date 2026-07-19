import { NextRequest } from 'next/server';
import { requireApiKey, ApiError } from '@/lib/apiAuth';
import { apiSuccess, apiFailure, parseJson } from '@/lib/apiResponse';
import { createMeeting, listMeetings } from '@/lib/ncService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-plan participant ceilings mirror the public pricing tiers.
const MAX_PARTICIPANTS: Record<string, number> = {
  free: 30,
  starter: 100,
  pro: 200,
  business: 500,
  enterprise: 100000,
};

/**
 * POST /api/v1/meetings
 * Create a meeting (LiveKit room). Body: { name: string, maxParticipants?: number, metadata?: object }
 */
export async function POST(req: NextRequest) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const body = await parseJson<{
      name?: string;
      maxParticipants?: number;
      metadata?: Record<string, unknown>;
    }>(req);

    if (!body.name || typeof body.name !== 'string') {
      throw new ApiError(400, 'invalid_request', 'Field "name" is required.');
    }

    const planCap = MAX_PARTICIPANTS[ctx.key.plan] ?? MAX_PARTICIPANTS.free;
    const requested = body.maxParticipants ?? planCap;
    if (requested > planCap) {
      throw new ApiError(
        403,
        'plan_limit',
        `Your plan allows up to ${planCap} participants.`
      );
    }

    const meeting = await createMeeting({
      ownerUserId: ctx.key.ownerUserId,
      name: body.name,
      maxParticipants: requested,
      metadata: body.metadata,
    });

    return apiSuccess(meeting, rate, 201);
  } catch (err) {
    return apiFailure(err);
  }
}

/**
 * GET /api/v1/meetings
 * List meetings owned by the API key holder.
 */
export async function GET(req: NextRequest) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const meetings = await listMeetings(ctx.key.ownerUserId);
    return apiSuccess(meetings, rate);
  } catch (err) {
    return apiFailure(err);
  }
}

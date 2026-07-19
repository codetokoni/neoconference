import { NextRequest } from 'next/server';
import { requireApiKey, ApiError } from '@/lib/apiAuth';
import { apiSuccess, apiFailure } from '@/lib/apiResponse';
import { getMeeting, listRecordings, signRecordingUrl } from '@/lib/ncService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/meetings/:id/recordings
 * List recordings for a meeting with short-lived presigned download URLs.
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

    const recordings = await listRecordings(params.id);
    const withUrls = await Promise.all(
      recordings.map(async (r) => ({
        key: r.key,
        sizeBytes: r.sizeBytes,
        lastModified: r.lastModified,
        downloadUrl: await signRecordingUrl(r.key, 3600),
        downloadUrlExpiresIn: 3600,
      }))
    );

    return apiSuccess(withUrls, rate);
  } catch (err) {
    return apiFailure(err);
  }
}

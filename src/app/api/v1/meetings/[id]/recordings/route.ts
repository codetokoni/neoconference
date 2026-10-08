import { NextRequest } from 'next/server';
import { requireApiKey, ApiError, type AuthContext } from '@/lib/apiAuth';
import { apiSuccess, apiFailure } from '@/lib/apiResponse';
import { getMeeting, type Meeting } from '@/lib/ncService';
import { listRecordings, signGetUrl } from '@/lib/r2';
import { rememberEgressOwner } from '@/lib/recordingUsage';
import { recordingGate, startRoomRecording, stopRoomRecordings } from '@/lib/roomRecording';
import { apiRecordings, meetingRecordingPrefix } from '@/lib/apiShapes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

/** The meeting, if it is the key owner's. */
async function ownMeeting(ctx: AuthContext, id: string): Promise<Meeting> {
  const meeting = await getMeeting(id);
  if (!meeting || meeting.ownerUserId !== ctx.key.ownerUserId) {
    throw new ApiError(404, 'not_found', 'Meeting not found.');
  }
  return meeting;
}

/**
 * GET /api/v1/meetings/:id/recordings
 * The meeting's recordings, newest first, with download links that work for
 * an hour: each recording's video and its audio-only copy.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const meeting = await ownMeeting(ctx, params.id);
    const objects = await listRecordings(meetingRecordingPrefix(meeting.ownerUserId, meeting.slug), 200);
    return apiSuccess(await apiRecordings(objects, signGetUrl), rate);
  } catch (err) {
    return apiFailure(err);
  }
}

/**
 * POST /api/v1/meetings/:id/recordings
 * Start recording the meeting. The same rules as Record on the website:
 * the owner's plan must include recording (Pro and above), within its
 * hours this month. Files appear in GET once the recording is stopped.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const meeting = await ownMeeting(ctx, params.id);
    if (meeting.status === 'ended') {
      throw new ApiError(409, 'meeting_ended', 'This meeting has already ended.');
    }
    const allowed = await recordingGate(meeting.ownerUserId);
    if (!allowed.ok) throw new ApiError(402, allowed.code, allowed.message);

    let started;
    try {
      started = await startRoomRecording({ room: meeting.slug, recorderUserId: meeting.ownerUserId });
    } catch (e) {
      // Most often nobody is in the meeting yet: its room only exists while
      // someone is connected (or for 10 minutes after creation).
      console.warn('[api/v1] recording start failed', meeting.id, e);
      throw new ApiError(
        409,
        'recording_not_started',
        'The recording could not start. Start it once someone has joined the meeting.'
      );
    }
    if (!allowed.exempt) await rememberEgressOwner(started.egressId, meeting.ownerUserId);

    return apiSuccess(
      {
        recordingId: started.egressId,
        startedAt: new Date().toISOString(),
        ...(allowed.warning ? { warning: allowed.warning } : {}),
      },
      rate,
      201
    );
  } catch (err) {
    return apiFailure(err);
  }
}

/**
 * DELETE /api/v1/meetings/:id/recordings
 * Stop every recording running in the meeting. Ending the meeting stops
 * them too.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const { ctx, rate } = await requireApiKey(req);
    const meeting = await ownMeeting(ctx, params.id);
    const stopped = await stopRoomRecordings(meeting.slug);
    return apiSuccess({ stopped: stopped.length }, rate);
  } catch (err) {
    return apiFailure(err);
  }
}

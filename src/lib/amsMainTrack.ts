import { AMS_REST, videoChannelForRoom } from "@/lib/simulcast";
import { roomMainTrack } from "@/lib/participantCodes";

/**
 * Ensure the AMS broadcast objects for a room exist.
 *
 * A NeoConference room needs two broadcast records registered in AMS:
 *
 *   `<room>-room`   — the multi-track WRAPPER viewers subscribe to.
 *                     Has no media of its own; groups subtracks.
 *   `<room>-video`  — the video-bearing SUBTRACK vMix/OBS pushes to,
 *                     with `mainTrackStreamId: <room>-room` linking
 *                     it into the group.
 *
 * Both records need to already exist when the publisher connects.
 * When one is missing:
 *   - Missing wrapper → dashboard's WebRTC subscription hangs. Audience
 *     sees "ON AIR" behind a black picture, AMS shows `speed=0.5,
 *     zombi=true`. Root cause of the 2026-09-10 mid-event outage.
 *   - Missing video subtrack → the recording toggle fails with
 *     "No stream for this id: <room>-video ... Record type is null"
 *     because AMS has no broadcast entity to write recordType onto.
 *
 * AMS aggressively garbage-collects broadcast records whose publishers
 * have disconnected, so we can't rely on "created once, exists
 * forever". These helpers self-heal on every read path.
 *
 * All operations are idempotent: AMS returns HTTP 200 with
 * `{success:false, message:"Stream id is already being used"}` when
 * the record already exists — that's the happy path here, not an
 * error. Timeout-bounded (4s) and never throw: callers are on
 * request-serving hot paths and must not fail because AMS is having
 * a bad day.
 */

interface EnsureResult {
  ok: boolean;
  created: boolean;
  reason?: string;
}

async function createBroadcast(
  streamId: string,
  payload: Record<string, unknown>,
): Promise<EnsureResult> {
  try {
    const r = await fetch(`${AMS_REST}/broadcasts/create`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamId, ...payload }),
    });
    const body = (await r.json().catch(() => null)) as
      | { success?: boolean; message?: string; streamId?: string }
      | null;
    if (r.ok) {
      const alreadyExists =
        body?.success === false &&
        typeof body?.message === "string" &&
        /already/i.test(body.message);
      return { ok: true, created: !alreadyExists };
    }
    return { ok: false, created: false, reason: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, created: false, reason: (e as Error).message };
  }
}

export async function ensureMainTrackWrapper(
  room: string,
  displayName?: string,
): Promise<EnsureResult> {
  const streamId = roomMainTrack(room);
  const name = (displayName?.trim() || room) + " main";
  return createBroadcast(streamId, { name });
}

/**
 * Ensure the video-bearing subtrack (`<room>-video`) exists AND is
 * linked to the room's main-track wrapper as a subtrack. Wiring the
 * `mainTrackStreamId` field is what makes AMS route the video into
 * the group viewers subscribe to.
 */
export async function ensureVideoSubtrack(
  room: string,
  displayName?: string,
): Promise<EnsureResult> {
  const streamId = videoChannelForRoom(room).id;
  const name = (displayName?.trim() || room) + " video";
  return createBroadcast(streamId, {
    name,
    mainTrackStreamId: roomMainTrack(room),
  });
}

/**
 * Ensure both the wrapper AND the video subtrack exist for a room.
 * Wrapper is created first because the subtrack's
 * `mainTrackStreamId` reference has to resolve to something for AMS
 * to accept the subtrack. If wrapper creation succeeds (or the
 * wrapper was already there), the subtrack call goes through even if
 * either was refused — one broken half is still worth healing.
 */
export async function ensureRoomBroadcasts(
  room: string,
  displayName?: string,
): Promise<{ wrapper: EnsureResult; video: EnsureResult }> {
  const wrapper = await ensureMainTrackWrapper(room, displayName);
  const video = await ensureVideoSubtrack(room, displayName);
  return { wrapper, video };
}

const lastAttemptAt = new Map<string, number>();
const RETRY_MS = 30_000;

/**
 * Fire-and-forget wrapper-and-subtrack ensure. Debounced per room
 * (30s) so a burst of dashboard polls does not translate into a
 * burst of create calls if AMS keeps refusing writes.
 */
export function ensureRoomBroadcastsInBackground(
  room: string,
  displayName?: string,
): void {
  const now = Date.now();
  const prev = lastAttemptAt.get(room) ?? 0;
  if (now - prev < RETRY_MS) return;
  lastAttemptAt.set(room, now);
  void ensureRoomBroadcasts(room, displayName).then((res) => {
    if (res.wrapper.created) {
      // eslint-disable-next-line no-console
      console.log(`[amsMainTrack] auto-created wrapper for ${room}`);
    } else if (!res.wrapper.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[amsMainTrack] failed to ensure wrapper for ${room}: ${res.wrapper.reason}`,
      );
    }
    if (res.video.created) {
      // eslint-disable-next-line no-console
      console.log(`[amsMainTrack] auto-created video subtrack for ${room}`);
    } else if (!res.video.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[amsMainTrack] failed to ensure video subtrack for ${room}: ${res.video.reason}`,
      );
    }
  });
}

/**
 * Kept for backward compatibility with existing callers. Prefer
 * ensureRoomBroadcastsInBackground for new code.
 */
export function ensureMainTrackWrapperInBackground(
  room: string,
  displayName?: string,
): void {
  ensureRoomBroadcastsInBackground(room, displayName);
}

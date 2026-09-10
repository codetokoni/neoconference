import { AMS_REST } from "@/lib/simulcast";
import { roomMainTrack } from "@/lib/participantCodes";

/**
 * Ensure the AMS main-track wrapper for a room exists.
 *
 * Background: viewers subscribe to the multi-track group `<room>-room`
 * (see roomMainTrack). Individual booth streams (`<room>-video`,
 * `<room>-a-fr`, …) are subtracks of that group. When the wrapper
 * exists, AMS keeps every subtrack's audio + video routed to the
 * correct viewers. When it does NOT exist, subtracks still accept
 * publishers but the dashboard's WebRTC subscription to `<room>-room`
 * hangs — the audience sees "ON AIR" behind a black picture and a
 * `speed=0.5, zombi=true` broadcast in AMS's admin panel. This is
 * exactly the failure we hit mid-event on 2026-09-10, resolved by
 * curl-POSTing `broadcasts/create` for `neoconf-room` by hand.
 *
 * Idempotent: AMS returns a JSON body with `success: false` and
 * `message: "Stream id is already being used"` if the wrapper is
 * already there — that is the happy path here, not an error.
 *
 * Timeout-bounded and non-throwing: callers are on request-serving
 * hot paths (createRoom, status poll) and should never take an AMS
 * outage as a reason to fail the user's own operation.
 */
export async function ensureMainTrackWrapper(
  room: string,
  displayName?: string,
): Promise<{ ok: boolean; created: boolean; reason?: string }> {
  const streamId = roomMainTrack(room);
  const name = (displayName?.trim() || room) + " main";

  try {
    const r = await fetch(`${AMS_REST}/broadcasts/create`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamId, name }),
    });
    // AMS returns 200 for both "created" and "already exists" — the
    // shape is `{success, message, ...}` or the full broadcast record.
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

/**
 * Fire-and-forget wrapper. Used from request-serving code paths that
 * must not block on AMS. Debounced per room so a burst of dashboard
 * polls does not translate into a burst of create calls if the
 * wrapper stays missing (AMS refusing writes, disk full, etc).
 */
const lastAttemptAt = new Map<string, number>();
const RETRY_MS = 30_000;

export function ensureMainTrackWrapperInBackground(
  room: string,
  displayName?: string,
): void {
  const now = Date.now();
  const prev = lastAttemptAt.get(room) ?? 0;
  if (now - prev < RETRY_MS) return;
  lastAttemptAt.set(room, now);
  // The Promise result is intentionally discarded — this is a
  // best-effort self-heal, not a request-critical operation.
  void ensureMainTrackWrapper(room, displayName).then((res) => {
    if (res.created) {
      // eslint-disable-next-line no-console
      console.log(`[amsMainTrack] auto-created wrapper for ${room}`);
    } else if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[amsMainTrack] failed to ensure wrapper for ${room}: ${res.reason}`,
      );
    }
  });
}

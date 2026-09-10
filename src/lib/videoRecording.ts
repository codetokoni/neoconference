import { AMS_HTTP, AMS_REST, videoChannelForRoom } from "@/lib/simulcast";

/**
 * Programme-feed recording control via Ant Media Server REST.
 *
 * The recording target is the room's VIDEO subtrack
 * (`videoChannelForRoom(room).id`, e.g. `<room>-video`), NOT the
 * `<room>-room` multi-track wrapper. The wrapper is a placeholder
 * that has no media of its own — subtracks carry the frames — and
 * AMS returns 400 when asked to toggle recordType on it. The
 * `<room>-video` subtrack is where vMix/OBS actually pushes the
 * mixed programme feed, so recording it captures exactly what the
 * audience sees.
 *
 * Recorded files land under `${AMS_HTTP}/streams/<name>.mp4` and are
 * enumerated via the `/vods/*` REST endpoint. The file naming
 * convention AMS uses embeds the streamId, so we filter by prefix on
 * our side rather than trusting a query parameter that isn't
 * available across every AMS version.
 */

export type RecordType = "NONE" | "MP4" | "WEBM" | "HLS";

export interface RecordingState {
  streamId: string;
  recordType: RecordType;
  live: boolean;
  updateTimeMs: number | null;
}

export interface RecordedVod {
  vodId: string;
  filename: string;
  url: string;
  sizeBytes: number;
  durationMs: number;
  createdAtMs: number;
}

const REST_TIMEOUT_MS = 5000;

/**
 * Turn an unsuccessful AMS response into an error that names the
 * status AND the response body. Without the body, a 400 from AMS is
 * indistinguishable from every other 400 and every debug session
 * starts by curl-ing the same endpoint by hand — a preventable tax.
 */
async function throwAmsError(r: Response): Promise<never> {
  const body = await r
    .text()
    .then((t) => t.slice(0, 200).replace(/\s+/g, " ").trim())
    .catch(() => "");
  throw new Error(`AMS ${r.status}${body ? `: ${body}` : ""}`);
}

function recordingTargetFor(room: string): string {
  return videoChannelForRoom(room).id;
}

/**
 * Read the current recording state of the room's programme feed.
 * Returns null when AMS has no record of the broadcast — either the
 * publisher hasn't ever pushed frames, or the id doesn't match.
 */
export async function getRecordingState(
  room: string,
): Promise<RecordingState | null> {
  const streamId = recordingTargetFor(room);
  const r = await fetch(
    `${AMS_REST}/broadcasts/${encodeURIComponent(streamId)}`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    },
  );
  if (r.status === 404) return null;
  if (!r.ok) await throwAmsError(r);
  const body = (await r.json()) as {
    streamId?: string;
    recordType?: RecordType;
    status?: string;
    updateTime?: number;
  };
  const recordType: RecordType =
    (body.recordType as RecordType | undefined) ?? "NONE";
  return {
    streamId,
    recordType,
    // "broadcasting" is the AMS status when the publisher is
    // actively pushing. Anything else (finished, created, etc.)
    // means we're not currently capturing.
    live: (body.status ?? "").toLowerCase() === "broadcasting",
    updateTimeMs: typeof body.updateTime === "number" ? body.updateTime : null,
  };
}

/**
 * Turn recording on for the room's programme feed. Uses AMS's
 * dedicated recording toggle endpoint:
 *
 *   PUT /rest/v2/broadcasts/{id}/recording/{true|false}?recordType=MP4
 *
 * Older code tried to PUT a partial broadcast body against
 * `/broadcasts/{id}` — that returns 400 on every AMS version we've
 * seen. The dedicated endpoint is what the AMS admin console itself
 * calls and is stable across 2.9 → 2.14.
 *
 * `recordType=MP4` — the file lands as one contiguous MP4 when the
 * broadcast ends, which is what people expect to download. HLS
 * recording produces .ts segments + a playlist and requires
 * post-processing before distribution.
 */
export async function setRecording(
  room: string,
  recordType: RecordType,
): Promise<RecordingState | null> {
  const streamId = recordingTargetFor(room);
  const enable = recordType !== "NONE";
  const type = enable ? recordType : "MP4"; // AMS wants a valid type even when disabling
  const url =
    `${AMS_REST}/broadcasts/${encodeURIComponent(streamId)}` +
    `/recording/${enable ? "true" : "false"}` +
    `?recordType=${encodeURIComponent(type)}`;
  const r = await fetch(url, {
    method: "PUT",
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  });
  if (r.status === 404) return null;
  if (!r.ok) await throwAmsError(r);
  // Re-read so the returned state reflects what AMS actually stored
  // (some versions coerce the recordType field silently).
  return getRecordingState(room);
}

/**
 * List MP4 files AMS has recorded for the room's programme feed.
 * Filters by filename prefix so the caller doesn't accidentally get
 * VODs from unrelated broadcasters on the same AMS instance.
 *
 * Newest first — matches what a producer wants when the goal is
 * "grab the clip from the segment that just finished."
 */
export async function listRecordings(room: string): Promise<RecordedVod[]> {
  const streamId = recordingTargetFor(room);
  const r = await fetch(`${AMS_REST}/vods/list/0/200`, {
    cache: "no-store",
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  });
  if (!r.ok) await throwAmsError(r);
  const list = (await r.json()) as Array<{
    vodId?: string;
    vodName?: string;
    filePath?: string;
    fileSize?: number;
    duration?: number;
    creationDate?: number;
    streamId?: string;
  }>;
  const out: RecordedVod[] = [];
  for (const v of list) {
    const filename = v.vodName || v.filePath?.split("/").pop() || "";
    if (!filename) continue;
    // Only keep recordings that belong to this room's programme feed.
    // AMS names files like `<streamId>_<timestamp>.mp4`.
    const belongsToRoom =
      v.streamId === streamId || filename.startsWith(streamId + "_");
    if (!belongsToRoom) continue;
    out.push({
      vodId: v.vodId ?? filename,
      filename,
      url: `${AMS_HTTP.replace(/\/$/, "")}/streams/${encodeURIComponent(filename)}`,
      sizeBytes: v.fileSize ?? 0,
      durationMs: v.duration ?? 0,
      createdAtMs: v.creationDate ?? 0,
    });
  }
  out.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return out;
}

/** Delete one recorded VOD by id. Removes the file on the AMS side. */
export async function deleteRecording(vodId: string): Promise<boolean> {
  const r = await fetch(`${AMS_REST}/vods/${encodeURIComponent(vodId)}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  });
  if (r.status === 404) return false;
  if (!r.ok) await throwAmsError(r);
  return true;
}

import { AMS_HTTP, AMS_REST } from "@/lib/simulcast";

/**
 * Programme-feed recording control via Ant Media Server REST.
 *
 * AMS records each broadcast to an MP4 (or WebM / HLS, but MP4 is
 * what a viewer expects to download) when `recordType` is set on the
 * broadcast. We toggle that field on the room's MAIN track — the
 * `${room}-room` broadcaster — so the programme feed is captured;
 * per-participant recording is a separate opt-in and not needed for
 * "distribute a clip after the event" workflows.
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

function ok<T = unknown>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`AMS ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Read the current recording state of the room's main broadcaster.
 * Returns null when AMS has no record of the broadcast — either the
 * broadcaster hasn't been created yet, or the id doesn't match.
 */
export async function getRecordingState(
  room: string,
): Promise<RecordingState | null> {
  const streamId = `${room}-room`;
  const r = await fetch(
    `${AMS_REST}/broadcasts/${encodeURIComponent(streamId)}`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    },
  );
  if (r.status === 404) return null;
  const body = await ok<{
    streamId?: string;
    recordType?: RecordType;
    status?: string;
    updateTime?: number;
  }>(r);
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
 * Turn recording on for the room's main broadcaster. Uses PUT to
 * update just the `recordType` field so we don't touch anything else
 * about the broadcast configuration.
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
  const streamId = `${room}-room`;
  // AMS accepts PUT with a partial broadcast body; the field name is
  // `recordType` on the broadcast object.
  const r = await fetch(
    `${AMS_REST}/broadcasts/${encodeURIComponent(streamId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, recordType }),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`AMS ${r.status} ${r.statusText}`);
  // Re-read so the returned state reflects what AMS actually stored
  // (some versions coerce the recordType field silently).
  return getRecordingState(room);
}

/**
 * List MP4 files AMS has recorded for the room's main broadcaster.
 * Filters by filename prefix so the caller doesn't accidentally get
 * VODs from unrelated broadcasters on the same AMS instance.
 *
 * Newest first — matches what a producer wants when the goal is
 * "grab the clip from the segment that just finished."
 */
export async function listRecordings(room: string): Promise<RecordedVod[]> {
  const streamId = `${room}-room`;
  const r = await fetch(`${AMS_REST}/vods/list/0/200`, {
    cache: "no-store",
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`AMS ${r.status} ${r.statusText}`);
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
    // Only keep recordings that belong to this room's main
    // broadcaster. AMS names files like `<streamId>_<timestamp>.mp4`.
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
  if (!r.ok) throw new Error(`AMS ${r.status} ${r.statusText}`);
  return true;
}

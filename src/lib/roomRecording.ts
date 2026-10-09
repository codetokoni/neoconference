// src/lib/roomRecording.ts
//
// Recording a LiveKit room to R2, shared by the website (Record in a
// meeting, /api/livekit/egress/start) and the developer API
// (POST /api/v1/meetings/:id/recordings).
//
// Files land at 'recordings/<recorder>/<room>/<timestamp>.mp4', with an
// audio-only sidecar beside it ('.m4a'). The recordings lists read that
// layout (eventRecordings.ts for meetings, ncService for API meetings), so
// both callers must write it the same way: that is why it lives here.

import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} from "livekit-server-sdk";
import { getPlanLimitsForUserId, isAdminUserId } from "@/lib/plan";
import { recordedSeconds, recordingAllowance, usageMonth } from "@/lib/recordingUsage";
import { sanitizeSegment } from "@/lib/eventRecordings";
import { featureDecision } from "@/lib/platform/features";
import { featureRefusalMessage } from "@/lib/platform/model";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function egressClient(): EgressClient {
  const wsUrl = requiredEnv("NEXT_PUBLIC_LIVEKIT_URL");
  // The egress client talks HTTP to the same server.
  return new EgressClient(
    wsUrl.replace(/^ws/, "http"),
    requiredEnv("LIVEKIT_API_KEY"),
    requiredEnv("LIVEKIT_API_SECRET")
  );
}

export type RecordingGate =
  | { ok: true; exempt: boolean; warning?: string }
  | {
      ok: false;
      code: "plan_upgrade_required" | "recording_hours_used" | "feature_disabled";
      plan: string;
      message: string;
    };

/**
 * Whether the owner's plan lets this room be recorded now: recording is on
 * Pro and above, within the plan's hours this month. Admins are exempt
 * from the hours (and their recordings are not counted against them).
 */
export async function recordingGate(ownerUserId: string): Promise<RecordingGate> {
  const { plan, limits } = await getPlanLimitsForUserId(ownerUserId);
  // Feature controls (admin): off everywhere or for this account beats the
  // plan; an account allowed it records whatever the plan says.
  const feature = await featureDecision("recording", { userId: ownerUserId, plan, planAllows: limits.recording });
  if (!feature.enabled && feature.source !== "plan_default") {
    return { ok: false, code: "feature_disabled", plan, message: featureRefusalMessage(feature) };
  }
  if (!feature.enabled) {
    return {
      ok: false,
      code: "plan_upgrade_required",
      plan,
      message:
        "Recording is on the Pro plan and above. The meeting's owner can upgrade at neoconference.app/pricing.",
    };
  }
  const exempt = ownerUserId ? await isAdminUserId(ownerUserId) : false;
  if (exempt) return { ok: true, exempt };
  const allowance = recordingAllowance(
    limits.recordingHoursPerMonth,
    await recordedSeconds(ownerUserId, usageMonth(Date.now())),
    plan.charAt(0).toUpperCase() + plan.slice(1),
    Date.now()
  );
  if (!allowance.allowed) {
    return { ok: false, code: "recording_hours_used", plan, message: allowance.message };
  }
  return {
    ok: true,
    exempt,
    ...("warning" in allowance && allowance.warning ? { warning: allowance.warning } : {}),
  };
}

export interface StartedRecording {
  egressId: string;
  filepath: string;
  audioEgressId: string | null;
  audioFilepath: string | null;
}

/**
 * Start recording a room: the grid video, and an audio-only sidecar beside
 * it. A failed video start throws; a failed audio start leaves the video
 * running alone (logged).
 */
export async function startRoomRecording(input: {
  room: string;
  /** Whose folder the files go in: the person who pressed Record, or the API key's owner. */
  recorderUserId: string;
}): Promise<StartedRecording> {
  const s3Upload = new S3Upload({
    accessKey: requiredEnv("S3_ACCESS_KEY"),
    secret: requiredEnv("S3_SECRET_KEY"),
    bucket: requiredEnv("S3_BUCKET"),
    region: process.env.S3_REGION || "auto",
    endpoint: requiredEnv("S3_ENDPOINT"),
    forcePathStyle: true,
  });

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const basepath = `recordings/${sanitizeSegment(input.recorderUserId)}/${sanitizeSegment(input.room)}/${timestamp}`;
  const filepath = `${basepath}.mp4`;
  const audioFilepath = `${basepath}.m4a`;

  const client = egressClient();
  const [video, audio] = await Promise.allSettled([
    client.startRoomCompositeEgress(
      input.room,
      new EncodedFileOutput({
        fileType: EncodedFileType.MP4,
        filepath,
        output: { case: "s3", value: s3Upload },
      }),
      { layout: "grid" }
    ),
    client.startRoomCompositeEgress(
      input.room,
      new EncodedFileOutput({
        fileType: EncodedFileType.MP4,
        filepath: audioFilepath,
        output: { case: "s3", value: s3Upload },
      }),
      { audioOnly: true }
    ),
  ]);

  if (video.status === "rejected") throw video.reason;
  let audioEgressId: string | null = null;
  if (audio.status === "fulfilled") {
    audioEgressId = audio.value.egressId ?? null;
  } else {
    console.warn("[roomRecording] audio sidecar failed; continuing video-only", audio.reason);
  }
  return {
    egressId: video.value.egressId,
    filepath,
    audioEgressId,
    audioFilepath: audioEgressId ? audioFilepath : null,
  };
}

/** Stop every recording running in this room. Returns the egress ids stopped. */
export async function stopRoomRecordings(room: string): Promise<string[]> {
  const client = egressClient();
  const active = await client.listEgress({ roomName: room, active: true });
  const ids = active.map((e) => e.egressId).filter((id): id is string => Boolean(id));
  await Promise.all(ids.map((id) => client.stopEgress(id)));
  return ids;
}

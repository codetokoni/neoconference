import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { EgressClient } from "livekit-server-sdk";
import { eventStore } from "@/lib/eventStore";
import { authorize } from "@/lib/authz";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// Mirrors the key layout written by egress/start:
//   recordings/<userSeg>/<roomSeg>/<timestamp>.(mp4|m4a)
function sanitizeSegment(s: string): string {
  return (s || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "x";
}

const RECORDING_KEY_RE =
  /^recordings\/[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._-]{1,80}\/[0-9A-Za-z._-]{1,40}\.(mp4|m4a)$/;

/**
 * A presigned GET is a read grant on the bucket, so the object key can never
 * come from the request body unchecked. The key must look exactly like an
 * egress-written recording key AND sit in the folder of the room the caller
 * was just authorized for.
 */
function isAllowedRecordingKey(key: string, roomName: string): boolean {
  if (!RECORDING_KEY_RE.test(key)) return false;
  return key.split("/")[2] === sanitizeSegment(roomName);
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      egressId?: string;
      filepath?: string;
      audioEgressId?: string | null;
    };
    const egressId = (body.egressId || "").trim();
    const filepath = (body.filepath || "").trim();
    const audioEgressId = (body.audioEgressId || "").trim();
    if (!egressId) {
      return NextResponse.json({ error: "Missing egressId" }, { status: 400 });
    }

    const apiKey = requiredEnv("LIVEKIT_API_KEY");
    const apiSecret = requiredEnv("LIVEKIT_API_SECRET");
    const wsUrl = requiredEnv("NEXT_PUBLIC_LIVEKIT_URL");
    const httpUrl = wsUrl.replace(/^ws/, "http");

    const egressClient = new EgressClient(httpUrl, apiKey, apiSecret);

    // ---- Authz (F-2) ----
    // The body carries no room, so ask LiveKit which room this egress belongs
    // to rather than trusting the caller, then gate on that event.
    const found = await egressClient.listEgress({ egressId }).catch(() => []);
    const target = found[0];
    if (!target?.roomName) {
      return NextResponse.json({ error: "egress_not_found" }, { status: 404 });
    }
    const roomName = target.roomName;

    const ev = await eventStore.bySlug(roomName);
    if (!ev) {
      return NextResponse.json({ error: "event_not_found" }, { status: 404 });
    }
    const gate = await authorize(ev, "recording:stop");
    if (!gate.ok) return gate.response;

    // The audio sidecar must belong to the same room, or it is somebody
    // else's egress being stopped through our authorization.
    if (audioEgressId) {
      const audioFound = await egressClient
        .listEgress({ egressId: audioEgressId })
        .catch(() => []);
      if (audioFound[0]?.roomName !== roomName) {
        return NextResponse.json({ error: "egress_mismatch" }, { status: 400 });
      }
    }

    // Stop both video and audio egresses. The video stop is required; if the
    // audio sidecar exists, stop it in parallel via allSettled so an already-
    // stopped or failed audio egress doesn't break the video stop response.
    const stops: Promise<unknown>[] = [egressClient.stopEgress(egressId)];
    if (audioEgressId) {
      stops.push(egressClient.stopEgress(audioEgressId));
    }
    const [videoSettled, audioSettled] = await Promise.allSettled(stops);
    if (videoSettled.status === "rejected") {
      throw videoSettled.reason;
    }
    if (audioSettled && audioSettled.status === "rejected") {
      console.warn(
        "[egress/stop] audio sidecar stop failed; ignoring",
        audioSettled.reason,
      );
    }
    const info = videoSettled.value as { egressId?: string; status?: number | string };

    // Prefer the filename LiveKit reports; fall back to the body value only
    // after it passes the key check above.
    const reportedKey = (target.fileResults || [])
      .map((f) => f.filename)
      .find((f) => typeof f === "string" && f.length > 0);
    const signKey =
      reportedKey || (filepath && isAllowedRecordingKey(filepath, roomName) ? filepath : "");

    let downloadUrl: string | null = null;
    if (signKey) {
      const s3 = new S3Client({
        region: process.env.S3_REGION || "auto",
        endpoint: requiredEnv("S3_ENDPOINT"),
        forcePathStyle: true,
        credentials: {
          accessKeyId: requiredEnv("S3_ACCESS_KEY"),
          secretAccessKey: requiredEnv("S3_SECRET_KEY"),
        },
      });
      // Cloudflare R2 does not understand the AWS flexible-checksums extension.
      // Strip the middleware so x-amz-checksum-mode is never added.
      try {
        s3.middlewareStack.remove("flexibleChecksumsMiddleware");
      } catch {}
      const cmd = new GetObjectCommand({
        Bucket: requiredEnv("S3_BUCKET"),
        Key: signKey,
      });
      const signed = await getSignedUrl(s3, cmd, { expiresIn: 60 * 60 * 24 });
      const u = new URL(signed);
      u.searchParams.delete("x-amz-checksum-mode");
      u.searchParams.delete("x-id");
      downloadUrl = u.toString();
    }

    return NextResponse.json({
      ok: true,
      egressId: info.egressId,
      status: info.status,
      downloadUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

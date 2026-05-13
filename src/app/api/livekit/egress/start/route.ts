import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  EgressClient,
  EncodedFileType,
  EncodedFileOutput,
  S3Upload,
} from "livekit-server-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// Sanitize a path segment so it can safely sit inside an S3/R2 object key.
// Allows letters, digits, dot, dash, underscore. Everything else -> '-'.
function sanitizeSegment(s: string): string {
  return (s || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'x';
}

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { room?: string };
    const room = (body.room || "").trim();
    if (!room) {
      return NextResponse.json({ error: "Missing room" }, { status: 400 });
    }

    const apiKey = requiredEnv("LIVEKIT_API_KEY");
    const apiSecret = requiredEnv("LIVEKIT_API_SECRET");
    const wsUrl = requiredEnv("NEXT_PUBLIC_LIVEKIT_URL");

    // Convert wss:// -> https:// for the egress client base URL.
    const httpUrl = wsUrl.replace(/^ws/, "http");

    const s3AccessKey = requiredEnv("S3_ACCESS_KEY");
    const s3SecretKey = requiredEnv("S3_SECRET_KEY");
    const s3Endpoint = requiredEnv("S3_ENDPOINT");
    const s3Bucket = requiredEnv("S3_BUCKET");
    const s3Region = process.env.S3_REGION || "auto";

    const timestamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-");

    // NOTE: Object key is namespaced by the user who started the recording.
    // The recordings list/delete/rename APIs enforce that the authenticated
    // user's key prefix must match this layout, so users only ever see their
    // own recordings on the dashboard.
    const userSeg = sanitizeSegment(userId);
    const roomSeg = sanitizeSegment(room);
    const filepath = `recordings/${userSeg}/${roomSeg}/${timestamp}.mp4`;

    const fileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath,
      output: {
        case: "s3",
        value: new S3Upload({
          accessKey: s3AccessKey,
          secret: s3SecretKey,
          bucket: s3Bucket,
          region: s3Region,
          endpoint: s3Endpoint,
          forcePathStyle: true,
        }),
      },
    });

    const egressClient = new EgressClient(httpUrl, apiKey, apiSecret);

    const info = await egressClient.startRoomCompositeEgress(room, {
      file: fileOutput,
      layout: "grid",
    });

    return NextResponse.json({
      egressId: info.egressId,
      filepath,
      startedAt: Date.now(),
    });
  } catch (e: any) {
    console.error("egress/start failed", e);
    return NextResponse.json(
      { error: e?.message || "Failed to start egress" },
      { status: 500 }
    );
  }
}

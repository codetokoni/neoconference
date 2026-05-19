import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { EgressClient } from "livekit-server-sdk";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
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

    let downloadUrl: string | null = null;
    if (filepath) {
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
        Key: filepath,
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

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { EgressClient } from "livekit-server-sdk";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const runtime = "nodejs";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function POST(req: Request) {
  try {
    const { userId } = auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      egressId?: string;
      filepath?: string;
    };
    const egressId = (body.egressId || "").trim();
    const filepath = (body.filepath || "").trim();
    if (!egressId) {
      return NextResponse.json({ error: "Missing egressId" }, { status: 400 });
    }

    const apiKey = requiredEnv("LIVEKIT_API_KEY");
    const apiSecret = requiredEnv("LIVEKIT_API_SECRET");
    const wsUrl = requiredEnv("NEXT_PUBLIC_LIVEKIT_URL");
    const httpUrl = wsUrl.replace(/^ws/, "http");

    const egressClient = new EgressClient(httpUrl, apiKey, apiSecret);
    const info = await egressClient.stopEgress(egressId);

    let downloadUrl: string | null = null;
    if (filepath) {
      // Generate a presigned URL valid for 24 hours.
      const s3 = new S3Client({
        region: process.env.S3_REGION || "auto",
        endpoint: requiredEnv("S3_ENDPOINT"),
        credentials: {
          accessKeyId: requiredEnv("S3_ACCESS_KEY"),
          secretAccessKey: requiredEnv("S3_SECRET_KEY"),
        },
        forcePathStyle: true,
      });
      try {
        downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: requiredEnv("S3_BUCKET"),
            Key: filepath,
          }),
          { expiresIn: 60 * 60 * 24 }
        );
      } catch (e) {
        console.error("presign failed", e);
      }
    }

    return NextResponse.json({
      egressId: info.egressId,
      status: String(info.status),
      downloadUrl,
      filepath,
    });
  } catch (e: any) {
    console.error("egress/stop failed", e);
    return NextResponse.json(
      { error: e?.message || "Failed to stop egress" },
      { status: 500 }
    );
  }
}

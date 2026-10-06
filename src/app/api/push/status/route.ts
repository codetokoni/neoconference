// src/app/api/push/status/route.ts
//
// GET ?endpoint=<this browser's push endpoint>
//   -> { configured, devices, thisDevice }
// The server cannot tell which browser is asking, so the page passes its own
// subscription's endpoint (from pushManager.getSubscription()) when it has one.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { deviceId, isPushConfigured, listDevices } from "@/lib/pushStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const endpoint = new URL(req.url).searchParams.get("endpoint") || "";
  const devices = await listDevices(userId);
  return NextResponse.json(
    {
      configured: isPushConfigured(),
      devices: devices.size,
      thisDevice: endpoint.length > 0 && endpoint.length <= 2048 && devices.has(deviceId(endpoint)),
    },
    { headers: { "cache-control": "no-store" } }
  );
}

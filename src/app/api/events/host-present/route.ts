// src/app/api/events/host-present/route.ts
// Lightweight polling endpoint that tells a waiting guest whether a host or co-host is currently in the LiveKit room.
// Used by the room page when the token endpoint returned 403 wait_for_host.

import { NextRequest, NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { eventStore } from "@/lib/eventStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const slug = req.nextUrl.searchParams.get("slug");
    if (!slug) {
      return NextResponse.json(
        { error: "Missing slug" },
        { status: 400 }
      );
    }

    const ev = await eventStore.bySlug(slug);
    if (!ev) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
    if (!apiKey || !apiSecret || !wsUrl) {
      // If env is missing the gate is effectively bypassed by the token route, so report present.
      return NextResponse.json({ hostPresent: true, participantCount: 0 });
    }

    const httpUrl = wsUrl.replace(/^wss?:\/\//, "https://");
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);

    let hostPresent = false;
    let participantCount = 0;
    try {
      const parts = await svc.listParticipants(ev.livekitRoom);
      participantCount = parts.length;
      hostPresent = parts.some((p) => {
        try {
          const md = p.metadata ? JSON.parse(p.metadata) : null;
          return md?.role === "host" || md?.role === "cohost";
        } catch {
          return false;
        }
      });
    } catch {
      // Room does not exist yet → no host present.
      hostPresent = false;
      participantCount = 0;
    }

    return NextResponse.json({ hostPresent, participantCount });
  } catch (err) {
    console.error("[api/events/host-present] error:", err);
    return NextResponse.json(
      { error: "host_present_failed" },
      { status: 500 }
    );
  }
}

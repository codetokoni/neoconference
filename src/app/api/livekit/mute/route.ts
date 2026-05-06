import { NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { requireRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function httpUrlFromWs(ws: string | undefined): string {
  if (!ws) return "";
  return ws.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

/**
 * POST /api/livekit/mute
 * Body: { roomName: string; participantIdentity: string; trackSid: string; muted: boolean }
 * Only admins may call this. Mutes/unmutes a remote participant's published track.
 */
export async function POST(req: Request) {
  const caller = await requireRole(["admin"]);
  if (!caller) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    roomName?: string;
    participantIdentity?: string;
    trackSid?: string;
    muted?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const roomName = body.roomName?.trim();
  const identity = body.participantIdentity?.trim();
  const trackSid = body.trackSid?.trim();
  const muted = !!body.muted;

  if (!roomName || !identity || !trackSid) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const apiUrl = httpUrlFromWs(process.env.LIVEKIT_WS_URL);
  if (!apiKey || !apiSecret || !apiUrl) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  try {
    const svc = new RoomServiceClient(apiUrl, apiKey, apiSecret);
    await svc.mutePublishedTrack(roomName, identity, trackSid, muted);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "livekit_error", detail: msg }, { status: 500 });
  }
}

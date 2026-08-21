import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { eventStore } from "@/lib/eventStore";
import { authorize } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function httpUrlFromWs(ws: string | undefined): string {
  if (!ws) return "";
  return ws.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

/**
 * POST /api/livekit/mute
 * Body: { roomName: string; participantIdentity: string; trackSid: string; muted: boolean }
 *
 * Mutes/unmutes one published track. Requires 'participant:mute' on the event
 * that owns the room — owner, host or moderator, plus platform admins.
 *
 * Previously this was requireRole(["admin"]), i.e. platform admins only, which
 * meant the host of a meeting could not call the one endpoint that can mute a
 * specific track (F-5). /api/livekit/moderate remains the coarse path that
 * mutes a participant wholesale.
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  const ev = await eventStore.bySlug(roomName);
  if (!ev) {
    return NextResponse.json({ error: "event_not_found" }, { status: 404 });
  }
  const gate = await authorize(ev, "participant:mute");
  if (!gate.ok) return gate.response;

  // Self-moderation goes through the local track toggles, not the server API.
  if (identity === userId) {
    return NextResponse.json({ error: "cannot_moderate_self" }, { status: 400 });
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

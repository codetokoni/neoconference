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
 * Body: { roomName: string; participantIdentity: string; trackSid: string; muted: true }
 *
 * Mutes ONE published track. Requires 'participant:mute' on the event that
 * owns the room — owner, host or moderator, plus platform admins.
 *
 * Force-unmuting a specific participant's track is refused (400
 * remote_unmute_forbidden) per FRS §5.3: "administrators should not be able to
 * remotely activate someone's microphone without that person's permission."
 * To ask a participant to unmute, send requestUnmuteAudio / requestCameraOn
 * via /api/livekit/moderate — the target's client approves before their
 * track is enabled.
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

  if (!roomName || !identity || !trackSid) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  // FRS §5.3: no remote force-unmute. Ask-to-unmute lives on /moderate.
  if (body.muted === false) {
    return NextResponse.json(
      {
        error: "remote_unmute_forbidden",
        message: "Send requestUnmuteAudio via /api/livekit/moderate; the target approves client-side.",
      },
      { status: 400 }
    );
  }
  const muted = true;

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

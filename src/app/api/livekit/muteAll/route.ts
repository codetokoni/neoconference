// src/app/api/livekit/muteAll/route.ts
//
// POST — mute the microphone of every ordinary participant in a room.
//
// Body: { roomName: string; exceptIdentity?: string }
//
// FRS §5.1 "Mute All": keep Owner, Host, and active Moderators unmuted;
// mute everyone else.
//
// FRS §5.2 "Mute Everyone Else" is the same call with `exceptIdentity`
// set to the spotlighted speaker's identity — that participant additionally
// stays unmuted alongside the elevated roles.
//
// Role classification comes from the LiveKit participant metadata's "role"
// field (host/cohost/attendee), stamped by the token grant and updated live
// by /api/events/[id]/roles when someone is promoted/demoted mid-meeting.
//
// Authorization: participant:muteAll — RANK.moderator, so a cohost may mute
// everyone (permissions.ts; permissions.smoke.ts asserts it).

import { NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import { MUTE_CONCURRENCY, planMuteAll, runLimited } from "@/lib/muteAll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function httpUrlFromWs(ws: string | undefined): string {
  if (!ws) return "";
  return ws.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

interface Body {
  roomName?: unknown;
  exceptIdentity?: unknown;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const roomName = typeof body.roomName === "string" ? body.roomName.trim() : "";
  if (!roomName) return NextResponse.json({ error: "missing_room" }, { status: 400 });

  const exceptBase =
    typeof body.exceptIdentity === "string"
      ? body.exceptIdentity.trim().split("#")[0].toLowerCase()
      : "";

  const event = await eventStore.bySlug(roomName);
  if (!event) return NextResponse.json({ error: "event_not_found" }, { status: 404 });

  const gate = await authorize(event, "participant:muteAll");
  if (!gate.ok) return gate.response;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const apiUrl = httpUrlFromWs(process.env.LIVEKIT_WS_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL);
  if (!apiKey || !apiSecret || !apiUrl) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const svc = new RoomServiceClient(apiUrl, apiKey, apiSecret);
  const actorId = (gate.actor.userId || "").toLowerCase();

  let list;
  try {
    list = await svc.listParticipants(roomName);
  } catch (e) {
    console.error("[muteAll] listParticipants failed", e);
    return NextResponse.json({ error: "livekit_list_failed" }, { status: 500 });
  }

  // Only live microphones, several at a time (src/lib/muteAll.ts): one by
  // one, already-muted ones included, it kept the host on "Muting…".
  const started = Date.now();
  const plan = planMuteAll(list, { actorId, exceptBase });
  const result = await runLimited(plan.jobs, MUTE_CONCURRENCY, async (job) => {
    try {
      await svc.mutePublishedTrack(roomName, job.identity, job.trackSid, true);
    } catch (e) {
      // Usually someone who left between the list and the mute.
      console.warn("[muteAll] mutePublishedTrack failed", job.identity, job.trackSid, e);
      throw e;
    }
  });
  const muted = result.ok;
  const skipped = plan.skipped;
  // Counts and time only, so a slow "Muting…" can be read from the logs.
  console.info(
    "[muteAll] done",
    JSON.stringify({
      participants: list.length,
      muted,
      failed: result.failed,
      alreadyMuted: plan.alreadyMuted,
      skipped,
      ms: Date.now() - started,
    }),
  );

  return NextResponse.json({ ok: true, muted, skipped });
}

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
// Authorization: participant:muteAll — RANK.host (raised from moderator to
// match §5.1's Owner+Host phrasing).

import { NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";

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

  let muted = 0;
  let skipped = 0;

  for (const p of list) {
    const base = (p.identity || "").split("#")[0].toLowerCase();

    // Never mute the caller — defensive belt-and-suspenders with the role check.
    if (actorId && base === actorId) {
      skipped++;
      continue;
    }

    // §5.2: keep the exempted speaker unmuted.
    if (exceptBase && base === exceptBase) {
      skipped++;
      continue;
    }

    // Skip elevated roles per FRS §5.1. Metadata uses wire-format role
    // (owner/host collapse to "host", moderator to "cohost" via toLegacyRole).
    let role: string | undefined;
    try {
      const md = p.metadata ? JSON.parse(p.metadata) : {};
      role = typeof (md as { role?: unknown })?.role === "string"
        ? (md as { role: string }).role
        : undefined;
    } catch {
      role = undefined;
    }
    if (role === "host" || role === "cohost") {
      skipped++;
      continue;
    }

    // Find any published microphone tracks and mute them.
    const tracks = (p.tracks || []) as Array<{
      sid: string;
      source?: number | string;
      type?: number | string;
    }>;
    for (const t of tracks) {
      const src = typeof t.source === "string" ? t.source.toUpperCase() : t.source;
      const typ = typeof t.type === "string" ? t.type.toUpperCase() : t.type;
      // LiveKit sends source as enum int (2 = MICROPHONE) and type as int
      // (0 = AUDIO). Match by source first; fall back to type if unset.
      const isMic =
        src === "MICROPHONE" ||
        src === 2 ||
        (src === undefined && (typ === "AUDIO" || typ === 0));
      if (!isMic) continue;
      try {
        await svc.mutePublishedTrack(roomName, p.identity, t.sid, true);
        muted++;
      } catch (e) {
        console.warn("[muteAll] mutePublishedTrack failed", p.identity, t.sid, e);
      }
    }
  }

  return NextResponse.json({ ok: true, muted, skipped });
}

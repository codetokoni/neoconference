// src/app/api/events/host-present/route.ts
// Lightweight polling endpoint that tells a waiting guest whether a host or co-host is currently in the LiveKit room.
// Used by the room page when the token endpoint returned 403 wait_for_host.

import { NextRequest, NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { eventStore } from "@/lib/eventStore";
import { isAdmin } from "@/lib/roles";
import { getMeetingRole, getMeetingRoleByEmail } from "@/lib/meeting-roles";

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
      return NextResponse.json({ hostPresent: true, participantCount: 0 });
    }

    const httpUrl = wsUrl.replace(/^wss?:\/\//, "https://");
    const roomName = slug;
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);

    // Relaxed gate — "is any HUMAN participant already in the room."
    // Previously we tried to prove that a specific participant was
    // recognised as host via one of four detection paths (event owner,
    // ADMIN_EMAILS, participant metadata, Redis membership hash). Every
    // path had edge cases where a real host went undetected (metadata
    // race, Clerk userId vs email mismatch in identity, LiveKit
    // identity suffix quirks) and joiners got parked on the waiting
    // screen forever with the host clearly right there. See #129, #130,
    // and the pep-room incident that ate a day of debugging.
    //
    // Simpler rule matches how Zoom / Meet / Teams treat this: don't
    // let joiners into an empty room, but ANY human being present
    // counts as "meeting started." A joiner who wanders in early
    // still gets held; the moment any real participant appears, the
    // gate opens for everyone else.
    //
    // Agents (captions worker, future translation worker) are
    // deliberately excluded — a bot joining alone is not a "started"
    // meeting. LiveKit tags agent participants with a `kind` field
    // set to "agent"; we filter on that plus a name-prefix fallback
    // for older workers that don't set kind.
    void hostIds; // legacy set kept out of the decision below
    let hostPresent = false;
    let participantCount = 0;
    try {
      const parts = await svc.listParticipants(roomName);
      const humans = parts.filter((p) => {
        const kind = (p as { kind?: unknown }).kind;
        if (kind === 4 /* ParticipantInfo_Kind.AGENT */) return false;
        const identity = (p.identity || "").toLowerCase();
        if (identity.startsWith("agent-")) return false;
        if (identity.startsWith("neo-captions")) return false;
        return true;
      });
      participantCount = humans.length;
      hostPresent = humans.length > 0;
    } catch {
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

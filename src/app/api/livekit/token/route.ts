import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { AccessToken } from "livekit-server-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Allow letters, numbers, dashes and underscores in room names (1-64 chars)
const ROOM_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const room = req.nextUrl.searchParams.get("room");
    if (!room) {
      return NextResponse.json(
        { error: "Missing 'room' query param" },
        { status: 400 }
      );
    }
    if (!ROOM_NAME_REGEX.test(room)) {
      return NextResponse.json(
        { error: "Invalid room name" },
        { status: 400 }
      );
    }

    // ----- Waiting-room gate (event-bound rooms only) -----
    // If ?event=<slug> is supplied AND the event has waitingRoomEnabled=true,
    // attendees who are not host/cohost, not pre-approved, and not yet
    // admitted via the queue get a 403 with { error: 'waiting_room', status }.
    const eventSlug = req.nextUrl.searchParams.get("event");
    if (eventSlug) {
      try {
        const { eventStore } = await import("@/lib/eventStore");
        const ev = await eventStore.bySlug(eventSlug);
        if (ev && ev.waitingRoomEnabled) {
          const u = await currentUser().catch(() => null);
          const emails = (u?.emailAddresses || []).map(
            (e: { emailAddress: string }) => e.emailAddress.toLowerCase()
          );
          const isOwner = ev.ownerUserId === userId;
          const role = (ev.roles || []).find((r) => {
            const id = r.identifier.toLowerCase();
            return id === userId.toLowerCase() || emails.includes(id);
          });
          const isHostlike =
            isOwner || role?.role === "host" || role?.role === "cohost";
          const isPreApproved = Boolean(role?.preApproved);
          if (!isHostlike && !isPreApproved) {
            const entry = (ev.waitingRoom || []).find((e) => e.id === userId);
            if (!entry || entry.status !== "admitted") {
              return NextResponse.json(
                { error: "waiting_room", status: entry?.status || "not_knocked" },
                { status: 403 }
              );
            }
          }
        }
      } catch (gateErr) {
        console.error("[livekit/token] waiting-room gate error:", gateErr);
        // fall through and issue token rather than block on gate failure
      }
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

    if (!apiKey || !apiSecret || !wsUrl) {
      console.error(
        "[livekit/token] Missing env: ",
        { hasApiKey: !!apiKey, hasApiSecret: !!apiSecret, hasWsUrl: !!wsUrl }
      );
      return NextResponse.json(
        { error: "Server LiveKit env vars missing" },
        { status: 500 }
      );
    }

    const user = await currentUser();
    const displayName =
      user?.fullName ||
      user?.username ||
      user?.primaryEmailAddress?.emailAddress ||
      userId;

    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: displayName,
      ttl: "1h",
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();
    return NextResponse.json({ token, wsUrl });
  } catch (err) {
    console.error("[livekit/token] Unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to issue token" },
      { status: 500 }
    );
  }
}

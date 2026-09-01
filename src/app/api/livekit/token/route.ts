import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { getPlanForUserId, getPlanLimits, type Plan } from "@/lib/plan";
import { isAdmin } from "@/lib/roles";

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
          const isAdminCaller = emails.some((e) => isAdmin(e));
          const isHostlike =
            isOwner || isAdminCaller || role?.role === "host" || role?.role === "cohost";
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

      // ----- Wait-for-host gate (default on; non-host attendees must wait until a host/cohost is in the LiveKit room) -----
      try {
        const { eventStore: es2 } = await import("@/lib/eventStore");
        const ev2 = await es2.bySlug(eventSlug);
        if (ev2 && ev2.waitForHost !== false) {
          const u2 = await currentUser().catch(() => null);
          const emails2 = (u2?.emailAddresses || []).map(
            (e: { emailAddress: string }) => e.emailAddress.toLowerCase()
          );
          const isOwner2 = ev2.ownerUserId === userId;
          const role2 = (ev2.roles || []).find((r) => {
            const id = r.identifier.toLowerCase();
            return id === userId.toLowerCase() || emails2.includes(id);
          });
          const isAdminCaller2 = emails2.some((e) => isAdmin(e));
          const isHostlike2 =
            isOwner2 || isAdminCaller2 || role2?.role === "host" || role2?.role === "cohost";
          if (!isHostlike2) {
            const apiKey2 = process.env.LIVEKIT_API_KEY;
            const apiSecret2 = process.env.LIVEKIT_API_SECRET;
            const wsUrl2 = process.env.NEXT_PUBLIC_LIVEKIT_URL;
            if (apiKey2 && apiSecret2 && wsUrl2) {
              const httpUrl = wsUrl2.replace(/^wss?:\/\//, "https://");
              const svc = new RoomServiceClient(httpUrl, apiKey2, apiSecret2);
              // Relaxed gate — see /api/events/host-present for the
              // full rationale. Short version: proving a specific
              // participant is "host" through metadata / Redis /
              // roles[] kept producing false negatives that parked
              // joiners on the waiting screen with the host clearly
              // right there. Simpler rule: any HUMAN participant
              // counts as "meeting started." Agents (captions
              // worker, future translation worker) don't count.
              let hostPresent = false;
              try {
                const parts = await svc.listParticipants(room);
                const humans = parts.filter((p) => {
                  const kind = (p as { kind?: unknown }).kind;
                  if (kind === 4 /* ParticipantInfo_Kind.AGENT */) return false;
                  const identity = (p.identity || "").toLowerCase();
                  if (identity.startsWith("agent-")) return false;
                  if (identity.startsWith("neo-captions")) return false;
                  return true;
                });
                hostPresent = humans.length > 0;
              } catch (listErr) {
                // If the room does not exist yet, listParticipants throws â treat as no host present.
                hostPresent = false;
              }
              if (!hostPresent) {
                return NextResponse.json(
                  { error: "wait_for_host" },
                  { status: 403 }
                );
              }
            }
          }
        }
      } catch (whErr) {
        console.error("[livekit/token] wait-for-host gate error:", whErr);
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

    // ---- Plan-based gates: determine the host's plan, then enforce participant cap and emit limits in metadata ----
    let hostPlan: Plan = "free";
    try {
      let hostUserId: string | undefined;
      if (eventSlug) {
        try {
          const { eventStore: __es } = await import("@/lib/eventStore");
          const __ev = await __es.bySlug(eventSlug);
          if (__ev?.ownerUserId) hostUserId = __ev.ownerUserId;
        } catch {}
      }
      if (!hostUserId) hostUserId = userId;
      hostPlan = await getPlanForUserId(hostUserId);
    } catch (planErr) {
      console.error("[livekit/token] plan lookup failed:", planErr);
    }
    const planLimits = getPlanLimits(hostPlan);

    if (planLimits.maxParticipants > 0) {
      try {
        const svc = new RoomServiceClient(wsUrl, apiKey, apiSecret);
        const parts = await svc.listParticipants(room).catch(() => []);
        const alreadyIn = parts.some((p) => p.identity === userId);
        if (!alreadyIn && parts.length >= planLimits.maxParticipants) {
          return NextResponse.json(
            {
              error: "room_full",
              hostPlan,
              limit: planLimits.maxParticipants,
              message:
                hostPlan === "free"
                  ? "This room is full. The host is on the Free plan (max " +
                    planLimits.maxParticipants +
                    " participants). Ask the host to upgrade."
                  : "Room is at capacity (" + planLimits.maxParticipants + " participants).",
            },
            { status: 403 }
          );
        }
      } catch (capErr) {
        console.error("[livekit/token] participant cap check failed:", capErr);
      }
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: ((): string => { const n = req.nextUrl.searchParams.get("nonce") || ""; return /^[A-Za-z0-9_-]{1,32}$/.test(n) ? `${userId}#${n}` : userId; })(),
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
    let participantRole: string = "guest";
    try {
      if (eventSlug) {
        const { eventStore: __esRole, adoptOrphanRoom: __adoptRoom } = await import("@/lib/eventStore");
        let __evRole = await __esRole.bySlug(eventSlug);
        if (!__evRole) {
          // Orphan-room adoption: shared with /api/events/role so instant-meeting
          // hosts get role="host" baked into participant token metadata on first join.
          const __u = await currentUser().catch(() => null);
          const __primaryEmail = (__u?.emailAddresses?.find((e: { id: string; emailAddress: string }) => e.id === __u?.primaryEmailAddressId)?.emailAddress || __u?.emailAddresses?.[0]?.emailAddress || "").toLowerCase();
          __evRole = await __adoptRoom(eventSlug, userId, __primaryEmail || undefined);
        }
        if (__evRole) {
          // FRS §7.4: role restoration continues only until the meeting is
          // formally ended. Once state==='ended', a rejoin drops to attendee
          // regardless of any persisted assignment.
          if (__evRole.state === 'ended') {
            participantRole = "attendee";
          } else {
            const uRole = await currentUser().catch(() => null);
            const emailsRole = (uRole?.emailAddresses || []).map(
              (e: { emailAddress: string }) => e.emailAddress.toLowerCase()
            );
            const isAdminCallerRole = emailsRole.some((e) => isAdmin(e));
            if (isAdminCallerRole || __evRole.ownerUserId === userId) {
              participantRole = "host";
            } else {
              // Prefer the Redis membership hash — assignments made via
              // /api/events/[id]/roles land there and are the current source
              // of truth. getMeetingRole / getMeetingRoleByEmail also fall
              // back to the legacy event.roles[] array internally, so
              // pre-migration assignments continue to work without an
              // additional lookup here.
              const { getMeetingRole: __getMR, getMeetingRoleByEmail: __getMRByEmail } = await import("@/lib/meeting-roles");
              const { RANK: __RANK, toLegacyRole: __toLegacy } = await import("@/lib/permissions");
              const __lookups = await Promise.all([
                __getMR(__evRole.id, userId),
                ...emailsRole.map((e) => __getMRByEmail(__evRole!.id, e)),
              ]);
              const __hashRoles = __lookups.filter((r): r is NonNullable<typeof r> => !!r);
              if (__hashRoles.length > 0) {
                const __best = __hashRoles.reduce((a, b) => (__RANK[b] > __RANK[a] ? b : a));
                participantRole = __toLegacy(__best);
              } else {
                const matched = (__evRole.roles || []).find((r: { role: string; identifier: string }) => {
                  const id = r.identifier.toLowerCase();
                  return id === userId.toLowerCase() || emailsRole.includes(id);
                });
                if (matched?.role) participantRole = matched.role;
                else participantRole = "attendee";
              }
            }
          }
        }
      }
    } catch (roleErr) {
      console.error("[livekit/token] role resolve error:", roleErr);
    }
    // FRS §12.8: refuse new tokens for ordinary participants when the meeting
    // is locked. Owner, host, and cohost still get through so someone remains
    // able to unlock or admit specific people.
    try {
      if (eventSlug) {
        const { eventStore: __esLock } = await import("@/lib/eventStore");
        const __evLock = await __esLock.bySlug(eventSlug);
        if (__evLock?.isLocked) {
          const elevated = participantRole === "host" || participantRole === "cohost";
          if (!elevated) {
            return NextResponse.json(
              { error: "meeting_locked", message: "This meeting is locked. Ask the host to admit you." },
              { status: 403 }
            );
          }
        }
      }
    } catch (lockErr) {
      console.error("[livekit/token] lock check error:", lockErr);
    }

    at.metadata = JSON.stringify({ planLimits, hostPlan, role: participantRole });

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

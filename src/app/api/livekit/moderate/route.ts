// /src/app/api/livekit/moderate/route.ts
// Host-only moderation: mute audio, mute video, or remove a remote participant.
//
// Auth model: caller must be the event owner (role "host") OR have role "cohost"
// in event.roles. This mirrors the client-side check used by /api/events/role.
//
// POST body: {
//   slug: string;                                     // event slug == room name
//   action: "muteAudio" | "muteVideo" | "kick";
//   participantIdentity: string;
// }
import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { eventStore } from "@/lib/eventStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action = "muteAudio" | "muteVideo" | "kick" | "requestUnmuteAudio" | "requestCameraOn" | "makeCohost" | "demoteToAttendee";

export async function POST(req: Request) {
  let body: { slug?: string; action?: string; participantIdentity?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const slug = body.slug?.trim();
  const action = body.action?.trim() as Action | undefined;
  const identity = body.participantIdentity?.trim();

  if (!slug || !action || !identity) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (action !== "muteAudio" && action !== "muteVideo" && action !== "kick" && action !== "requestUnmuteAudio" && action !== "requestCameraOn" && action !== "makeCohost" && action !== "demoteToAttendee") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  // ---- Authn ----
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // ---- Authz: host (owner) or cohost ----
  const ev = await eventStore.bySlug(slug);
  if (!ev) {
    return NextResponse.json({ error: "event_not_found" }, { status: 404 });
  }

  const isOwner = ev.ownerUserId === userId;
  let isCohost = false;
  if (!isOwner) {
    const u = await currentUser().catch(() => null);
    const emails = (u?.emailAddresses || []).map((e: { emailAddress: string }) =>
      e.emailAddress.toLowerCase(),
    );
    const roles = ev.roles || [];
    const match = roles.find((r: { identifier?: string; role?: string }) => {
      const id = r.identifier?.toLowerCase();
      if (!id) return false;
      return id === userId.toLowerCase() || emails.includes(id);
    });
    isCohost = match?.role === "cohost";
  }

  if (!isOwner && !isCohost) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Self-moderation prevention: hosts can\'t kick/mute themselves through this
  // endpoint (use the local toggles instead).
  if (identity === userId) {
    return NextResponse.json({ error: "cannot_moderate_self" }, { status: 400 });
  }

  // ---- LiveKit server creds ----
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.LIVEKIT_WS_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !wsUrl) {
    return NextResponse.json({ error: "livekit_misconfigured" }, { status: 500 });
  }
  const apiUrl = wsUrl.replace(/^ws/, "http");
  const svc = new RoomServiceClient(apiUrl, apiKey, apiSecret);

  try {
        if (action === "kick" || action === "demoteToAttendee") {
      // For both: also strip any persisted role entry so the target cannot rejoin elevated.
      // For "kick" we additionally remove them from the live LiveKit room.
      // Guard: cannot target the event owner.
      if (ev.ownerUserId && ev.ownerUserId.toLowerCase() === identity.toLowerCase()) {
        return NextResponse.json({ error: "cannot_target_owner" }, { status: 400 });
      }
      try {
        const idLc = identity.toLowerCase();
        const prevRoles = (ev.roles || []) as Array<{ role: string; identifier: string; preApproved?: boolean }>;
        const nextRoles = prevRoles.filter((r) => (r.identifier || "").toLowerCase() !== idLc);
        if (nextRoles.length !== prevRoles.length) {
          await eventStore.update(ev.id, { roles: nextRoles });
        }
      } catch {
        // Non-fatal: persistence failure should not prevent the live action.
      }
      if (action === "kick") {
        await svc.removeParticipant(slug, identity);
        return NextResponse.json({ ok: true, action: "kick" });
      }
      // demoteToAttendee: push fresh metadata so the room UI flips live.
      try {
        const list = await svc.listParticipants(slug);
        const target = list.find((p) => (p.identity || "").toLowerCase() === identity.toLowerCase() || ((p.identity || "").split("#")[0].toLowerCase() === identity.toLowerCase()));
        if (target) {
          let md: Record<string, unknown> = {};
          try { md = target.metadata ? JSON.parse(target.metadata) : {}; } catch { md = {}; }
          md.role = "attendee";
          await svc.updateParticipant(slug, target.identity, JSON.stringify(md));
        }
      } catch {
        // Non-fatal: if not currently in the live room, persisted change still takes effect on rejoin.
      }
      return NextResponse.json({ ok: true, action: "demoteToAttendee" });
    }

    if (action === "makeCohost") {
      // Guard: cannot target the event owner (already the host).
      if (ev.ownerUserId && ev.ownerUserId.toLowerCase() === identity.toLowerCase()) {
        return NextResponse.json({ error: "cannot_target_owner" }, { status: 400 });
      }
      try {
        const idLc = identity.toLowerCase();
        const prevRoles = (ev.roles || []) as Array<{ role: string; identifier: string; preApproved?: boolean }>;
        const filtered = prevRoles.filter((r) => (r.identifier || "").toLowerCase() !== idLc);
        filtered.push({ role: "cohost", identifier: identity, preApproved: true });
        await eventStore.update(ev.id, { roles: filtered });
      } catch {
        // Non-fatal for the live update below.
      }
      try {
        const list = await svc.listParticipants(slug);
        const target = list.find((p) => (p.identity || "").toLowerCase() === identity.toLowerCase() || ((p.identity || "").split("#")[0].toLowerCase() === identity.toLowerCase()));
        if (target) {
          let md: Record<string, unknown> = {};
          try { md = target.metadata ? JSON.parse(target.metadata) : {}; } catch { md = {}; }
          md.role = "cohost";
          await svc.updateParticipant(slug, target.identity, JSON.stringify(md));
        }
      } catch {
        // Non-fatal: persistence already wrote the role for next rejoin.
      }
      return NextResponse.json({ ok: true, action: "makeCohost" });
    }

    // Request unmute mic / turn on camera: send a data message to the participant
    // who must approve it client-side before their track is enabled.
    if (action === "requestUnmuteAudio" || action === "requestCameraOn") {
      const me = await currentUser().catch(() => null);
      const fromName = me?.firstName || me?.username || (me?.emailAddresses?.[0]?.emailAddress) || "Host";
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "media_request",
          kind: action === "requestUnmuteAudio" ? "audio" : "video",
          to: identity,
          fromName,
          ts: Date.now(),
        }),
      );
      try {
        await (svc as any).sendData(slug, payload, 0, { destinationIdentities: [identity] });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: "send_failed", message: msg }, { status: 500 });
      }
      return NextResponse.json({ ok: true, action });
    }

        // Mute: look up the participant\'s tracks to find the right sid for the
    // requested source (audio = microphone, video = camera).
    const participant = await svc.getParticipant(slug, identity);
    const wantSource = action === "muteAudio" ? "MICROPHONE" : "CAMERA";
    const tracks = (participant?.tracks || []) as Array<{
      sid: string;
      source?: number | string;
      type?: number | string;
    }>;

    // LiveKit sends source as enum int (0=UNKNOWN,1=CAMERA,2=MICROPHONE,3=SCREEN_SHARE,...)
    // and type as int (0=AUDIO,1=VIDEO). Match by source first, fall back to type.
    const sourceMap: Record<string, number> = { CAMERA: 1, MICROPHONE: 2 };
    const typeMap: Record<string, number> = { CAMERA: 1, MICROPHONE: 0 };
    const sourceVal = sourceMap[wantSource];
    const typeVal = typeMap[wantSource];

    const target = tracks.find((tr) => {
      const src = typeof tr.source === "string" ? tr.source.toUpperCase() : tr.source;
      if (src === wantSource || src === sourceVal) return true;
      const typ = typeof tr.type === "string" ? tr.type.toUpperCase() : tr.type;
      return typ === (wantSource === "MICROPHONE" ? "AUDIO" : "VIDEO") || typ === typeVal;
    });

    if (!target) {
      return NextResponse.json(
        { error: "track_not_found", action, identity },
        { status: 404 },
      );
    }

    await svc.mutePublishedTrack(slug, identity, target.sid, true);
    return NextResponse.json({ ok: true, action, trackSid: target.sid });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "livekit_error", message: msg }, { status: 500 });
  }
}

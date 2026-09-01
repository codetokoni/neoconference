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

    // Legacy identity sources: event ownerUserId + roles[] array. These
    // are the two sources the route consulted before — kept as-is so
    // rooms that never used the RBAC route (which writes to the Redis
    // membership hash) still work.
    const hostIds = new Set<string>();
    if (ev.ownerUserId) hostIds.add(ev.ownerUserId.toLowerCase());
    if (ev.ownerEmail) hostIds.add(ev.ownerEmail.toLowerCase());
    (ev.roles || []).forEach((r: { role: string; identifier: string }) => {
      if ((r.role === "host" || r.role === "cohost") && r.identifier) {
        hostIds.add(r.identifier.toLowerCase());
      }
    });

    let hostPresent = false;
    let participantCount = 0;
    try {
      const parts = await svc.listParticipants(roomName);
      participantCount = parts.length;

      // Per-participant check. Return true if ANY of these holds:
      //   1. Identity matches ownerUserId / ownerEmail / roles[]
      //   2. Identity matches ADMIN_EMAILS — platform admins act as
      //      host in every room per resolveRole() in permissions.ts.
      //      The token route already grants them host-level metadata;
      //      this catches the case where the metadata write raced or
      //      lost the field for any reason.
      //   3. Identity is present in the Redis membership hash with
      //      role "host" or "cohost" — same fix pattern as PR #83 for
      //      /api/events/role and /api/livekit/token.
      //   4. Participant's own LiveKit metadata already declares
      //      role: "host" | "cohost" — this remains the fast path
      //      when everything is set up cleanly.
      hostPresent = false;
      for (const p of parts) {
        const raw = (p.identity || "").split("#")[0].toLowerCase();
        if (raw && hostIds.has(raw)) {
          hostPresent = true;
          break;
        }
        if (raw && isAdmin(raw)) {
          hostPresent = true;
          break;
        }
        try {
          const md = p.metadata ? JSON.parse(p.metadata) : null;
          if (md?.role === "host" || md?.role === "cohost") {
            hostPresent = true;
            break;
          }
        } catch {
          // fall through to Redis hash lookup
        }
        // Redis membership hash — only queried if the cheap in-memory
        // checks above didn't match. getMeetingRole falls back to the
        // legacy array internally, so a "cohost" written by either
        // pathway is caught here.
        if (raw) {
          const hashRole = await getMeetingRole(ev.id, raw);
          if (hashRole === "host" || hashRole === "moderator" || hashRole === "owner") {
            hostPresent = true;
            break;
          }
          // Identity may be an email for guest joiners.
          if (raw.includes("@")) {
            const emailRole = await getMeetingRoleByEmail(ev.id, raw);
            if (emailRole === "host" || emailRole === "moderator" || emailRole === "owner") {
              hostPresent = true;
              break;
            }
          }
        }
      }
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

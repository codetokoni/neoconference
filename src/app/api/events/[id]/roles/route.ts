// src/app/api/events/[id]/roles/route.ts
//
// Grant, change, or revoke a person's role in an event. This is the HTTP
// surface for the meeting-roles primitives — until now they were reachable
// only from server code with no client entry point.
//
// POST body:
//   { userId?: string, email?: string, role: MeetingRole }
//
//   role === "participant"        -> demote (remove elevated assignment)
//   role in ["host","moderator"]  -> assign or overwrite
//   role === "owner"              -> 400 (ownership is not transferable
//                                    through this API; use meeting:transfer)
//
// Authorization
//   role:grant  for assign paths  (RANK.host+)
//   role:revoke for demote path   (RANK.host+)
//
//   Additionally, the caller's rank must strictly exceed the target's current
//   assigned rank — so a host cannot demote or reassign another host per
//   FRS §1.2 (only the owner appoints/removes hosts). assignMeetingRole()
//   layers a second guard against the *requested* role via canManageRole().

import { NextResponse, type NextRequest } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import {
  assignMeetingRole,
  demoteToParticipant,
  getMeetingRole,
  getMeetingRoleByEmail,
  MeetingRoleError,
} from "@/lib/meeting-roles";
import { isMeetingRole, RANK, toLegacyRole, type MeetingRole } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  userId?: unknown;
  email?: unknown;
  role?: unknown;
}

const bad = (code: string, status = 400) =>
  NextResponse.json({ error: code }, { status });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!id) return bad("missing_event_id");

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return bad("invalid_json");
  }

  const role = typeof body.role === "string" ? body.role : "";
  if (!isMeetingRole(role)) return bad("invalid_role");
  if (role === "owner") return bad("cannot_assign_owner");

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!userId && !email) return bad("missing_target");

  // Path param may be either the event id or the event slug — mirrors the
  // fallthrough in authz.ts defaultResolveEvent so existing callers that only
  // hold the slug (like ParticipantsPanel) don't have to look up an id first.
  const event = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!event) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const permission = role === "participant" ? "role:revoke" : "role:grant";
  const gate = await authorize(event, permission);
  if (!gate.ok) return gate.response;

  // Rank guard against the target's current standing. The primitive checks
  // the *new* rank; this check covers the *current* rank so a host cannot
  // touch another host on either the demote path or a lateral reassignment.
  const current = await highestCurrentRole(event.id, userId || null, email || null);
  if (current && RANK[gate.actor.role] <= RANK[current]) {
    return bad("insufficient_rank", 403);
  }

  const identity = { userId: userId || undefined, emails: email ? [email] : [] };

  try {
    if (role === "participant") {
      await demoteToParticipant(event.id, identity);
    } else {
      // assignMeetingRole guards against self-promotion, owner-targeting, and
      // requested-role >= actor-rank via canManageRole().
      await assignMeetingRole(event.id, identity, role as MeetingRole, gate.actor);
    }
  } catch (err) {
    if (err instanceof MeetingRoleError) {
      switch (err.message) {
        case "event_not_found":
          return NextResponse.json({ error: "not_found" }, { status: 404 });
        case "cannot_manage_self":
        case "cannot_target_owner":
        case "insufficient_rank":
          return bad(err.message, 403);
        case "invalid_role":
        case "empty_identity":
        case "cannot_assign_owner":
          return bad(err.message);
        default:
          return NextResponse.json({ error: "write_failed" }, { status: 500 });
      }
    }
    console.error("[events/roles] unexpected error", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  // Best-effort live update so the room UI flips role badges and capability
  // gates without a rejoin. Failure here is non-fatal: the persisted role
  // still applies the next time the target joins.
  await broadcastRoleToLiveKit(event.slug, {
    userId: userId || undefined,
    emails: email ? [email] : [],
  }, role);

  return NextResponse.json({
    ok: true,
    eventId: event.id,
    target: { userId: userId || null, email: email || null },
    role,
  });
}

async function broadcastRoleToLiveKit(
  roomName: string,
  target: { userId?: string; emails?: string[] },
  role: MeetingRole
): Promise<void> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.LIVEKIT_WS_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!roomName || !apiKey || !apiSecret || !wsUrl) return;

  const wireRole = toLegacyRole(role); // "host" | "cohost" | "attendee"
  const idLc = target.userId?.toLowerCase() || null;
  const emailSet = new Set((target.emails || []).map((e) => e.toLowerCase()));

  try {
    const svc = new RoomServiceClient(wsUrl.replace(/^ws/, "http"), apiKey, apiSecret);
    const list = await svc.listParticipants(roomName);

    // LiveKit may append a "#..." suffix to the identity — match on the base.
    const matches = list.filter((p) => {
      const base = (p.identity || "").split("#")[0].toLowerCase();
      if (idLc && base === idLc) return true;
      if (emailSet.size && emailSet.has(base)) return true;
      return false;
    });

    await Promise.all(
      matches.map(async (p) => {
        let md: Record<string, unknown> = {};
        try { md = p.metadata ? JSON.parse(p.metadata) : {}; } catch { md = {}; }
        md.role = wireRole;
        await svc.updateParticipant(roomName, p.identity, JSON.stringify(md));
      })
    );
  } catch (err) {
    console.warn("[events/roles] livekit metadata push failed", err);
  }
}

/**
 * Highest role a target currently holds under either identity key. Both
 * paths are queried so a caller who has only one of (userId, email) still
 * gets the right answer when the row was written under the other.
 */
async function highestCurrentRole(
  eventId: string,
  userId: string | null,
  email: string | null
): Promise<MeetingRole | null> {
  const [byId, byEmail] = await Promise.all([
    userId ? getMeetingRole(eventId, userId) : Promise.resolve(null),
    email ? getMeetingRoleByEmail(eventId, email) : Promise.resolve(null),
  ]);
  if (byId && byEmail) return RANK[byId] >= RANK[byEmail] ? byId : byEmail;
  return byId ?? byEmail ?? null;
}

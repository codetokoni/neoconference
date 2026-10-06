// src/app/api/events/[id]/participants/route.ts
//
// Adding people to a group meeting while it runs — how a private call grows
// into a conference without anyone leaving. Nothing restarts: the newly
// invited are let in on their next knock at the waiting room.
//
// GET  — for the in-room "Add participants" panel: whether the caller may
//        add people here, and which group members are not yet in it.
//        404 unless this is a group meeting and the caller is in the group.
// POST { userIds?: string[], emails?: string[] }
//        group:participants:manage on the meeting's group (Moderator and up).
//        userIds must be members of the group; emails may be anyone.
//        409 unless the meeting is live or scheduled.
//        -> { added, notified: { sent, unreachable } }
//
// Path param: id or slug.

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { can } from "@/lib/permissions";
import { listMembers } from "@/lib/groupStore";
import { addParticipants, listInvited, type InviteTarget } from "@/lib/groupMeetings";
import { notifyInvitees } from "@/lib/groupNotify";
import { ringNow } from "@/lib/ringEngine";
import {
  groupErrorResponse,
  invalidBody,
  readJsonObject,
  requireGroupPermission,
} from "@/lib/groupAuthz";
import { membersByEmail, siteOrigin } from "@/lib/groupPeople";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_AT_ONCE = 50;

async function groupMeeting(idOrSlug: string) {
  const ev = (await eventStore.byId(idOrSlug)) ?? (await eventStore.bySlug(idOrSlug));
  return ev?.groupId && ev.groupMeeting ? ev : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ev = await groupMeeting(id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const gate = await requireGroupPermission(ev.groupId!, "group:read");
  if (!gate.ok) return gate.response;

  const canAdd =
    can(gate.actor, "group:participants:manage") &&
    (ev.state === "live" || ev.state === "scheduled") &&
    !ev.groupMeeting!.cancelledAt;
  let candidates: Array<{ userId: string; name: string; email?: string }> = [];
  if (canAdd && ev.groupMeeting!.kind === "call") {
    const [members, invited] = await Promise.all([listMembers(ev.groupId!), listInvited(ev.id)]);
    candidates = members
      .filter((m) => !invited.has(m.userId))
      .map((m) => ({ userId: m.userId, name: m.name, ...(m.email ? { email: m.email } : {}) }));
  }
  return NextResponse.json(
    {
      eventId: ev.id,
      groupId: ev.groupId,
      groupName: gate.group.name,
      kind: ev.groupMeeting!.kind,
      canAdd,
      // A whole-group meeting already invites every member; only people
      // from outside the group can be added to it, by email.
      candidates,
    },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ev = await groupMeeting(id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const gate = await requireGroupPermission(ev.groupId!, "group:participants:manage");
  if (!gate.ok) return gate.response;
  if (ev.groupMeeting!.cancelledAt || (ev.state !== "live" && ev.state !== "scheduled")) {
    return NextResponse.json({ error: "meeting_not_open" }, { status: 409 });
  }

  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  const userIds = body.userIds ?? [];
  const emails = body.emails ?? [];
  if (
    !Array.isArray(userIds) ||
    !Array.isArray(emails) ||
    userIds.length + emails.length === 0 ||
    userIds.length + emails.length > MAX_AT_ONCE ||
    !userIds.every((u) => typeof u === "string" && u.length > 0 && u.length <= 64) ||
    !emails.every((e) => typeof e === "string" && e.length <= 254 && EMAIL.test(e.trim()))
  ) {
    return invalidBody("invalid_members");
  }

  const members = await listMembers(ev.groupId!);
  const byId = new Map(members.map((m) => [m.userId, m]));
  const strangers = (userIds as string[]).filter((u) => !byId.has(u));
  if (strangers.length > 0) {
    return NextResponse.json({ error: "not_member", userIds: strangers }, { status: 400 });
  }

  const { found, missing } = await membersByEmail((emails as string[]).map((e) => e.trim().toLowerCase()));
  const targets: InviteTarget[] = [
    ...(userIds as string[]).map((u) => ({ userId: u, email: byId.get(u)!.email, name: byId.get(u)!.name })),
    ...found.map((m) => ({ userId: m.userId, email: m.email, name: m.name })),
    ...missing.map((email) => ({ email, name: email })),
  ];

  try {
    const added = await addParticipants(ev, targets, gate.member);
    const live = ev.state === "live";
    // Into a meeting that is on, the new people are rung (and only they);
    // into one that has not started, they are invited and rung at its start.
    const notified = await notifyInvitees(
      ev,
      added.map((t) => ({ userId: t.userId, email: t.email, name: t.name || t.email || "Guest" })),
      live ? "added" : "scheduled",
      { senderUserId: gate.member.userId, senderName: gate.member.name, origin: siteOrigin(req) },
      live ? { kingschat: false, inApp: false, push: false } : {}
    );
    const newIds = added.map((t) => t.userId).filter((u): u is string => Boolean(u));
    if (live && newIds.length > 0) await ringNow(ev.id, { only: newIds });
    return NextResponse.json({
      ok: true,
      added: added.map((t) => ({ userId: t.userId, email: t.email, name: t.name })),
      notified: { sent: notified.sent, unreachable: notified.unreachable },
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

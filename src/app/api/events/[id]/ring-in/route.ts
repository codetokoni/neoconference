// src/app/api/events/[id]/ring-in/route.ts
//
// POST { groupId, userIds } — ring members of one of your groups into this
// meeting, now, the way a group meeting rings its people: a call on their
// phone and browser, a missed call if they do not answer, rings repeated as
// the group's settings say. For a meeting that is not a group meeting (your
// room, a meeting from your list); a group meeting has its own invitees and
// "Ring again" (src/app/api/events/[id]/ring/route.ts).
//
// Who may: someone who may invite people into this meeting (role:invite,
// host and up) and may call in that group (group:call, Moderator and up).
// The people must be members of that group. The meeting must be on.
// Path param: id or slug.
//   200 { ok, rung: userId[], busy: userId[] }
//
// GET — for the room's "Call people in": whether this meeting can ring
// people now, and the groups this person may call from, with their members
// (themselves left out). 404 for a group meeting (it has its own calling),
// 403 for someone who may not invite.
//   200 { open: boolean, groups: [{ id, name, members: [{ userId, name }] }] }

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { authorize, getIdentity } from "@/lib/authz";
import { groupActor, groupCapabilities, listGroupsForUser, listMembers, type GroupMember } from "@/lib/groupStore";
import { isOver, ringIntoMeeting } from "@/lib/ringEngine";
import { invalidBody, readJsonObject, requireGroupPermission } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ev = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!ev || ev.groupMeeting) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const gate = await authorize(ev, "role:invite");
  if (!gate.ok) return gate.response;
  const identity = await getIdentity();
  if (!identity.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const me = identity.userId;
  const callable = (await listGroupsForUser(me)).filter(
    (g) =>
      groupCapabilities(
        groupActor({ userId: me, emails: identity.emails, isPlatformAdmin: identity.isPlatformAdmin }, { role: g.role } as GroupMember),
      ).call,
  );
  const groups = await Promise.all(
    callable.map(async (g) => ({
      id: g.group.id,
      name: g.group.name,
      members: (await listMembers(g.group.id)).filter((m) => m.userId !== me).map((m) => ({ userId: m.userId, name: m.name })),
    })),
  );
  return NextResponse.json(
    { open: !isOver(ev) && ev.state === "live", groups },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ev = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ev.groupMeeting) return NextResponse.json({ error: "group_meeting" }, { status: 409 });
  const gate = await authorize(ev, "role:invite");
  if (!gate.ok) return gate.response;
  if (isOver(ev) || ev.state !== "live") return NextResponse.json({ error: "meeting_not_open" }, { status: 409 });

  const body = await readJsonObject(req);
  const groupId = body?.groupId;
  const userIds = body?.userIds;
  if (typeof groupId !== "string" || !groupId) return invalidBody("invalid_group");
  if (
    !Array.isArray(userIds) ||
    userIds.length === 0 ||
    userIds.length > 100 ||
    !userIds.every((u) => typeof u === "string" && u.length > 0 && u.length <= 64)
  ) {
    return invalidBody("invalid_members");
  }

  const group = await requireGroupPermission(groupId, "group:call");
  if (!group.ok) return group.response;
  const members = new Set((await listMembers(groupId)).map((m) => m.userId));
  const strangers = (userIds as string[]).filter((u) => !members.has(u));
  if (strangers.length > 0) return NextResponse.json({ error: "not_members", userIds: strangers }, { status: 400 });

  const callerId = group.member.userId;
  const people = (userIds as string[]).filter((u) => u !== callerId);
  if (people.length === 0) return invalidBody("invalid_members");

  const round = await ringIntoMeeting(ev.id, { groupId, callerId, userIds: people });
  return NextResponse.json({ ok: true, rung: round.rung, busy: round.busy });
}

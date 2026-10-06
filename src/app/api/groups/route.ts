// src/app/api/groups/route.ts
//
// GET  — the caller's groups, with their role in each and a member count.
// POST — create a group. The caller becomes its Owner.
//
//   { name, description?, iconUrl?, fromEventId?, memberUserIds? }
//
// memberUserIds is only accepted with fromEventId: the caller must be host or
// above on that meeting, and every id must be one of its signed-in attendees.
// Adding anyone else goes through the members route, which needs an email.

import { NextResponse } from "next/server";
import { authorize, getIdentity, unauthorized } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import { createGroup, listGroupsForUser, GROUP_LIMITS, type NewMember } from "@/lib/groupStore";
import { groupErrorResponse, invalidBody, readJsonObject } from "@/lib/groupAuthz";
import { eventAttendees, hasAttendance, selectAttendees } from "@/lib/groupAttendees";
import { currentMember } from "@/lib/groupPeople";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await getIdentity();
  if (!userId) return unauthorized();
  const rows = await listGroupsForUser(userId);
  return NextResponse.json(
    { groups: rows.map((r) => ({ ...r.group, role: r.role, memberCount: r.memberCount })) },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const { userId } = await getIdentity();
  if (!userId) return unauthorized();

  const body = await readJsonObject(req);
  if (!body) return invalidBody();

  const { fromEventId, memberUserIds } = body;
  if (fromEventId !== undefined && (typeof fromEventId !== "string" || !fromEventId.trim())) {
    return invalidBody("invalid_event");
  }
  if (
    memberUserIds !== undefined &&
    (!Array.isArray(memberUserIds) ||
      memberUserIds.length > GROUP_LIMITS.membersMax ||
      !memberUserIds.every((v) => typeof v === "string" && v.length > 0 && v.length <= 64))
  ) {
    return invalidBody("invalid_members");
  }
  const wanted = Array.from(new Set((memberUserIds as string[] | undefined) ?? [])).filter((id) => id !== userId);
  if (wanted.length > 0 && !fromEventId) return invalidBody("members_need_event");

  let sourceEventId: string | undefined;
  let members: NewMember[] = [];
  if (typeof fromEventId === "string") {
    const event = (await eventStore.byId(fromEventId)) ?? (await eventStore.bySlug(fromEventId));
    if (!event) return NextResponse.json({ error: "event_not_found" }, { status: 404 });
    const gate = await authorize(event, "transcript:read");
    if (!gate.ok) return gate.response;
    if (!hasAttendance(event)) return NextResponse.json({ error: "not_started" }, { status: 409 });

    const { attendees } = await eventAttendees(event);
    const picked = selectAttendees(attendees, wanted);
    if (!picked.ok) {
      return NextResponse.json({ error: "not_attendee", userIds: picked.notAttendees }, { status: 400 });
    }
    sourceEventId = event.id;
    members = picked.members;
  }

  const creator = await currentMember();
  if (!creator) return unauthorized();

  try {
    const group = await createGroup(
      { name: body.name, description: body.description, iconUrl: body.iconUrl, sourceEventId },
      creator,
      members
    );
    return NextResponse.json({ ok: true, group }, { status: 201 });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

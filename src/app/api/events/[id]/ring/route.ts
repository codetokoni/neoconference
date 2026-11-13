// src/app/api/events/[id]/ring/route.ts
//
// POST { userIds } — "Ring again": ring these people now, as if they had
// never been rung (their count starts over). Moderator and up
// (group:participants:manage). Only people invited to the meeting (or, for
// a meeting that is not a group meeting, rung into it: ring-in); 409 unless
// it is on.
// Path param: id or slug.

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { inviteesOf } from "@/lib/groupMeetings";
import { getRingInto, isOver, ringAgain } from "@/lib/ringEngine";
import { invalidBody, readJsonObject, requireGroupPermission } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ev = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const rungInto = ev.groupMeeting ? null : await getRingInto(ev.id);
  const groupId = ev.groupMeeting ? ev.groupId : rungInto?.groupId;
  if (!groupId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const gate = await requireGroupPermission(groupId, "group:participants:manage");
  if (!gate.ok) return gate.response;
  if (isOver(ev) || ev.state !== "live") return NextResponse.json({ error: "meeting_not_open" }, { status: 409 });

  const body = await readJsonObject(req);
  const userIds = body?.userIds;
  if (
    !Array.isArray(userIds) ||
    userIds.length === 0 ||
    userIds.length > 100 ||
    !userIds.every((u) => typeof u === "string" && u.length > 0 && u.length <= 64)
  ) {
    return invalidBody("invalid_members");
  }
  const invited = new Set(rungInto ? rungInto.userIds : (await inviteesOf(ev)).map((r) => r.userId).filter(Boolean));
  const strangers = (userIds as string[]).filter((u) => !invited.has(u));
  if (strangers.length > 0) return NextResponse.json({ error: "not_invited", userIds: strangers }, { status: 400 });

  const round = await ringAgain(ev.id, userIds as string[]);
  return NextResponse.json({ ok: true, rung: round.rung, busy: round.busy });
}

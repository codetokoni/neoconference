// src/app/api/groups/[id]/meetings/[eid]/route.ts
//
// PATCH  { scope: "this" | "following", title?, description?, scheduledAt?,
//          durationMin?, password? (null or "" clears it), waitingRoom? }
// DELETE ?scope=this|following  — cancel
//
// Both need group:schedule, apply only to meetings that have not started,
// and tell everyone invited (a cancellation takes it off their calendar).
// "following" covers this meeting and every later one in its series.

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";
import {
  cancelGroupMeetings,
  inviteesOf,
  updateGroupMeetings,
  type ChangeScope,
} from "@/lib/groupMeetings";
import { notifyInvitees } from "@/lib/groupNotify";
import {
  groupErrorResponse,
  invalidBody,
  readJsonObject,
  requireGroupPermission,
} from "@/lib/groupAuthz";
import { siteOrigin } from "@/lib/groupPeople";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; eid: string }> };

/** The meeting, only if it belongs to this group — otherwise the same 404 as a missing one. */
async function meetingOf(gid: string, eid: string) {
  const ev = await eventStore.byId(eid);
  return ev && ev.groupId === gid && ev.groupMeeting ? ev : null;
}

function parseScope(v: unknown): ChangeScope | null {
  if (v === undefined || v === null || v === "this") return "this";
  if (v === "following") return "following";
  return null;
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id, eid } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:schedule");
  if (!gate.ok) return gate.response;
  const ev = await meetingOf(id, eid);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  const scope = parseScope(body.scope);
  if (!scope) return invalidBody("invalid_scope");
  const allowed = new Set(["scope", "title", "description", "scheduledAt", "durationMin", "password", "waitingRoom"]);
  if (Object.keys(body).some((k) => !allowed.has(k))) return invalidBody("unknown_field");

  try {
    const changed = await updateGroupMeetings(
      ev,
      {
        title: body.title,
        description: body.description,
        scheduledAt: body.scheduledAt,
        durationMin: body.durationMin,
        password: body.password,
        waitingRoom: body.waitingRoom,
      },
      scope,
      gate.member
    );
    const origin = siteOrigin(req);
    const notified = changed.length
      ? await notifyInvitees(changed, await inviteesOf(changed[0], gate.member.userId), "updated", {
          senderUserId: gate.member.userId,
          senderName: gate.member.name,
          origin,
        })
      : { sent: 0, unreachable: 0 };
    return NextResponse.json({
      ok: true,
      updated: changed.map((e) => ({ id: e.id, start: e.scheduledAt })),
      notified: { sent: notified.sent, unreachable: notified.unreachable },
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id, eid } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:schedule");
  if (!gate.ok) return gate.response;
  const ev = await meetingOf(id, eid);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const scope = parseScope(new URL(req.url).searchParams.get("scope"));
  if (!scope) return invalidBody("invalid_scope");

  try {
    // Who to tell is read before cancelling: afterwards the meeting is archived.
    const recipients = await inviteesOf(ev, gate.member.userId);
    const cancelled = await cancelGroupMeetings(ev, scope, gate.member);
    const notified = cancelled.length
      ? await notifyInvitees(cancelled, recipients, "cancelled", {
          senderUserId: gate.member.userId,
          senderName: gate.member.name,
          origin: siteOrigin(req),
        })
      : { sent: 0, unreachable: 0 };
    return NextResponse.json({
      ok: true,
      cancelled: cancelled.map((e) => e.id),
      notified: { sent: notified.sent, unreachable: notified.unreachable },
    });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

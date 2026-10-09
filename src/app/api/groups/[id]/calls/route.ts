// src/app/api/groups/[id]/calls/route.ts
//
// POST { userIds: string[], title? } — a private call with chosen members
// (group:call). Every id must be a member of the group; the caller is in it
// automatically. Live at once; only the people in it are let in, and more
// can be added while it runs (POST /api/events/[id]/participants).
// -> 201 { slug, eventUrl, roomUrl, notified }

import { NextResponse } from "next/server";
import { createGroupMeetings, inviteesOf, cleanMeetingFields } from "@/lib/groupMeetings";
import { notifyInvitees } from "@/lib/groupNotify";
import { ringNow } from "@/lib/ringEngine";
import {
  groupErrorResponse,
  invalidBody,
  readJsonObject,
  requireGroupPermission,
} from "@/lib/groupAuthz";
import { meetingGates, siteOrigin } from "@/lib/groupPeople";
import { getPlanForUserId } from "@/lib/plan";
import { featureDecision, featureRefusal } from "@/lib/platform/features";
import { getPlatformSettings } from "@/lib/platform/settings";
import { activity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:call");
  if (!gate.ok) return gate.response;
  // Feature controls (admin), for the caller, who owns the call's meeting.
  const caller = gate.member.userId;
  const calls = await featureDecision("group_calls", { userId: caller, plan: await getPlanForUserId(caller) });
  if (!calls.enabled) return featureRefusal(calls);

  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  const { userIds } = body;
  if (
    !Array.isArray(userIds) ||
    userIds.length === 0 ||
    userIds.length > 100 ||
    !userIds.every((u) => typeof u === "string" && u.length > 0 && u.length <= 64)
  ) {
    return invalidBody("invalid_members");
  }

  try {
    const fields = cleanMeetingFields(
      {
        title:
          typeof body.title === "string" && body.title.trim()
            ? body.title
            : `${gate.member.name}'s call · ${gate.group.name}`.slice(0, 120),
        timezone: typeof body.timezone === "string" ? body.timezone : (await getPlatformSettings()).regional.defaultTimezone,
      },
      "call"
    );
    const origin = siteOrigin(req);
    const { events } = await createGroupMeetings(
      { group: gate.group, creator: gate.member, kind: "call", fields, callUserIds: userIds as string[], origin },
      meetingGates
    );
    const ev = events[0];
    // The ring carries the push, bell entry and KingsChat fallback; the
    // notice itself goes by email only.
    const notified = await notifyInvitees(
      ev,
      await inviteesOf(ev, gate.member.userId),
      "started",
      { senderUserId: gate.member.userId, senderName: gate.member.name, origin },
      { kingschat: false, inApp: false, push: false }
    );
    await ringNow(ev.id, { except: gate.member.userId });
    await activity.record("group.call", { userId: gate.member.userId, props: { groupId: id, eventId: ev.id, invited: (userIds as string[]).length } });
    return NextResponse.json(
      {
        ok: true,
        slug: ev.slug,
        eventUrl: "/" + ev.slug,
        roomUrl: "/" + ev.slug,
        notified: { sent: notified.sent, unreachable: notified.unreachable },
      },
      { status: 201 }
    );
  } catch (err) {
    return groupErrorResponse(err);
  }
}

// src/app/api/groups/[id]/meetings/route.ts
//
// GET  ?scope=upcoming|past&cursor=  the group's meetings (group:read).
//      Upcoming: live first, then soonest. Past: newest first, a page at a
//      time, with how many attended. Private calls are listed only to the
//      people in them.
// POST { mode: "scheduled" | "now", ...fields }
//      scheduled (group:schedule): title, description?, scheduledAt,
//        durationMin, timezone, password?, waitingRoom?, extraEmails?,
//        recurrence? { freq, interval, byWeekday?, until?, count? }
//      now (group:start): title, durationMin?, timezone? — live at once for
//        the whole group; the caller goes straight in.
//      -> 201 { slug, eventUrl, roomUrl, events: [{ id, slug, start }], notified }
//
// Each meeting is its own event owned by the group Owner; see
// src/lib/groupMeetings.ts for roles, admission and the plan gates.

import { NextResponse } from "next/server";
import {
  cleanMeetingFields,
  createGroupMeetings,
  inviteesOf,
  listGroupMeetings,
  type InviteTarget,
} from "@/lib/groupMeetings";
import { eventAttendees } from "@/lib/groupAttendees";
import { notifyInvitees } from "@/lib/groupNotify";
import { ringNow } from "@/lib/ringEngine";
import {
  groupErrorResponse,
  invalidBody,
  readJsonObject,
  requireGroupPermission,
} from "@/lib/groupAuthz";
import { meetingGates, membersByEmail, siteOrigin } from "@/lib/groupPeople";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") === "past" ? "past" : "upcoming";
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor && /^\d{1,16}$/.test(rawCursor) ? Number(rawCursor) : undefined;

  const { items, nextCursor } = await listGroupMeetings(id, gate.member.userId, scope, {
    cursor,
    countAttended: async (ev) => {
      const { attendees, guests } = await eventAttendees(ev);
      return attendees.length + guests.length;
    },
  });
  return NextResponse.json({ items, nextCursor }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  const mode = body.mode;
  if (mode !== "scheduled" && mode !== "now") return invalidBody("invalid_mode");

  const gate = await requireGroupPermission(id, mode === "scheduled" ? "group:schedule" : "group:start");
  if (!gate.ok) return gate.response;

  let extras: InviteTarget[] = [];
  if (mode === "scheduled" && body.extraEmails !== undefined) {
    const raw = body.extraEmails;
    if (
      !Array.isArray(raw) ||
      raw.length > 50 ||
      !raw.every((e) => typeof e === "string" && e.length <= 254 && EMAIL.test(e.trim()))
    ) {
      return invalidBody("invalid_members");
    }
    const emails = (raw as string[]).map((e) => e.trim().toLowerCase());
    // An address with an account is invited as that account, so they are
    // let in under any of their addresses; the rest by address.
    const { found, missing } = await membersByEmail(emails);
    extras = [
      ...found.map((m) => ({ userId: m.userId, email: m.email, name: m.name })),
      ...missing.map((email) => ({ email, name: email })),
    ];
  }

  try {
    const fields = cleanMeetingFields(body, mode);
    const origin = siteOrigin(req);
    const { events, seriesId } = await createGroupMeetings(
      { group: gate.group, creator: gate.member, kind: mode, fields, extras, origin },
      meetingGates
    );
    const first = events[0];
    const recipients = await inviteesOf(first, gate.member.userId);
    const notifyCtx = { senderUserId: gate.member.userId, senderName: gate.member.name, origin };
    // A scheduled meeting is announced now and rung at its start (the
    // scheduler). One starting now rings everyone at once; its push, bell
    // entry and KingsChat fallback come from the ring, so the notice itself
    // goes by email only.
    const notified =
      mode === "scheduled"
        ? await notifyInvitees(events, recipients, "scheduled", notifyCtx)
        : await notifyInvitees(events, recipients, "started", notifyCtx, { kingschat: false, inApp: false, push: false });
    if (mode === "now") await ringNow(first.id, { except: gate.member.userId });
    return NextResponse.json(
      {
        ok: true,
        slug: first.slug,
        eventUrl: "/" + first.slug,
        roomUrl: "/" + first.slug,
        ...(seriesId ? { seriesId } : {}),
        events: events.map((e) => ({ id: e.id, slug: e.slug, start: e.scheduledAt || e.startedAt })),
        notified: { sent: notified.sent, unreachable: notified.unreachable },
      },
      { status: 201 }
    );
  } catch (err) {
    return groupErrorResponse(err);
  }
}

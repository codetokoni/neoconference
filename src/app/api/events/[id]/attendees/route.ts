// src/app/api/events/[id]/attendees/route.ts
//
// GET — who attended a live or finished meeting, for "Create group from
// attendees". Signed-in people come back once each, by userId; guests come
// back separately, by name only, because they have no account to add.
//
// Path param: id or slug (byId ?? bySlug fallthrough, as the attendance export).
// Authorization: transcript:read (RANK.host) — the same gate as the attendance
// report this list is read from.

import { NextResponse, type NextRequest } from "next/server";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import { eventAttendees, hasAttendance } from "@/lib/groupAttendees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const event = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!event) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const gate = await authorize(event, "transcript:read");
  if (!gate.ok) return gate.response;

  if (!hasAttendance(event)) {
    return NextResponse.json({ error: "not_started" }, { status: 409 });
  }

  const { attendees, guests } = await eventAttendees(event);
  return NextResponse.json(
    {
      event: { id: event.id, slug: event.slug, name: event.name, state: event.state },
      attendees,
      guests: guests.map((name) => ({ name })),
    },
    { headers: { "cache-control": "no-store" } }
  );
}

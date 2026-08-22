// src/app/api/golive/stop/route.ts
//
// POST — end an active broadcast for an event.
//
// Body: { eventSlug?: string; roomName?: string }  (either identifies the event)
//
// Clears event.streamlab so RTMP credentials are no longer advertised to
// joiners. The meeting itself keeps running (event.state stays whatever it
// was) — this route is only about the broadcast, not the session.
//
// Authorization: stream:golive (same as /api/golive), so ending the
// broadcast requires the same rank as starting it (RANK.host+).

import { NextResponse } from "next/server";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { eventSlug?: string; roomName?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const slug = (body.eventSlug || body.roomName || "").trim();
  if (!slug) {
    return NextResponse.json({ ok: false, error: "missing_event" }, { status: 400 });
  }

  const event = await eventStore.bySlug(slug);
  if (!event) {
    return NextResponse.json({ ok: false, error: "event_not_found" }, { status: 404 });
  }

  const gate = await authorize(event, "stream:golive");
  if (!gate.ok) return gate.response;

  // Clearing streamlab drops the RTMP creds from the record; the meeting
  // itself keeps running. updatedAt is bumped so cache invalidators notice.
  await eventStore.update(event.id, (prev) => ({
    ...prev,
    streamlab: undefined,
    updatedAt: new Date().toISOString(),
  }));

  return NextResponse.json({ ok: true });
}

// src/app/api/me/presence/route.ts
//
// POST   { eventSlug }  "I'm in this meeting" — sent by the room every 60 s;
//                       lasts 90 s (src/lib/presence.ts).
// DELETE                 "I left".
// The ring engine reads it to leave alone people already in the meeting and
// to avoid ringing over someone's other meeting.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { clearPresence, setPresence } from "@/lib/presence";
import { invalidBody, readJsonObject } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonObject(req);
  const slug = typeof body?.eventSlug === "string" ? body.eventSlug.trim() : "";
  if (!slug || slug.length > 80) return invalidBody("invalid_event");
  const ev = await eventStore.bySlug(slug);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await setPresence(userId, { eventSlug: ev.slug, eventId: ev.id, ts: Date.now() });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await clearPresence(userId);
  return NextResponse.json({ ok: true });
}

// src/app/api/attendance/beacon/route.ts
//
// POST — client beacon for attendance capture (FRS §4).
//
// Body: { slug: string; action: "join" | "leave" }
//
// Client-side backstop for the LiveKit webhook. Fires from the room page on
// mount ("join") and on beforeunload / room disconnect ("leave"). If the
// LiveKit participant_joined / participant_left webhooks are configured
// they'll also land in the store; the aggregator dedupes because a person's
// userId is stable across both sources.
//
// Authorization: authenticated only. We stamp the userId, primary email, and
// display name from Clerk — never from the body — so a caller can't attribute
// an entry to someone else.

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { recordAttendance } from "@/lib/attendance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  slug?: unknown;
  action?: unknown;
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const rawAction = typeof body.action === "string" ? body.action : "";
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  if (rawAction !== "join" && rawAction !== "leave" && rawAction !== "inactive") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const event = await eventStore.bySlug(slug);
  if (!event) {
    return NextResponse.json({ error: "event_not_found" }, { status: 404 });
  }

  const u = await currentUser().catch(() => null);
  const primaryEmail =
    (u?.emailAddresses?.find((e: { id: string; emailAddress: string }) => e.id === u?.primaryEmailAddressId)
      ?.emailAddress ||
      u?.emailAddresses?.[0]?.emailAddress ||
      "").toLowerCase();
  const name =
    [u?.firstName, u?.lastName].filter(Boolean).join(" ") ||
    u?.username ||
    primaryEmail ||
    userId;

  await recordAttendance(event.id, {
    action: rawAction,
    userId,
    name,
    email: primaryEmail || undefined,
    source: "beacon",
  });

  return NextResponse.json({ ok: true });
}

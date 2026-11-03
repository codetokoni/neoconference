// src/app/api/auth/device-meetings/route.ts
//
// POST { sessions: string[] } -> { removed }: takes signed-out sessions'
// devices out of the meetings they joined (src/lib/deviceMeetings.ts).
// Middleware calls it right after a sign-in signs other devices out; it
// cannot reach LiveKit itself. Public on purpose: only sessions already
// signed out are acted on, and taking those out of a meeting is exactly
// what should happen to them anyway.

import { NextRequest, NextResponse } from "next/server";
import { removeFromMeetings } from "@/lib/deviceMeetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { sessions?: unknown } | null;
  const sessions = Array.isArray(body?.sessions) ? body.sessions.filter((s): s is string => typeof s === "string") : [];
  if (sessions.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json({ removed: await removeFromMeetings(sessions) });
}

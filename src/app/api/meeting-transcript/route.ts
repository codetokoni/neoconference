import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { addSegments, cleanRoom, type IncomingSegment } from "@/lib/meetingTranscript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/meeting-transcript?room=<livekit room>  { segments: [{ id, speaker, text }] }
 *
 * Participants' pages send the meeting's finished caption sentences, so
 * "What did I miss?" has a transcript to summarise. Signed-in only; each
 * sentence is kept once however many pages send it (see meetingTranscript).
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const room = cleanRoom(new URL(req.url).searchParams.get("room"));
  if (!room) return NextResponse.json({ ok: false, error: "room required" }, { status: 400 });

  let body: { segments?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
  const segments = (Array.isArray(body.segments) ? body.segments : [])
    .filter((s): s is IncomingSegment => Boolean(s) && typeof s === "object")
    .slice(0, 50);

  const added = await addSegments(room, segments);
  return NextResponse.json({ ok: true, added });
}

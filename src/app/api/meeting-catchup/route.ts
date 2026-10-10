import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getCatchUp } from "@/lib/catchUp";
import { cleanRoom, meetingLines } from "@/lib/meetingTranscript";
import { TRANSLATION_LANGUAGES } from "@/lib/translationLanguages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LANGS = new Set(["en", ...TRANSLATION_LANGUAGES.map((l) => l.code)]);

/**
 * GET /api/meeting-catchup?room=<livekit room>&lang=fr
 *
 * "What did I miss?" in a meeting: the same shared, cost-bounded summary as
 * the programme player (src/lib/catchUp.ts), from the meeting's caption
 * transcript (src/lib/meetingTranscript.ts). Signed-in only, like the room.
 */
export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const room = cleanRoom(url.searchParams.get("room"));
  const lang = (url.searchParams.get("lang") ?? "en").trim().toLowerCase().slice(0, 12);
  if (!room) return NextResponse.json({ ok: false, error: "room required" }, { status: 400 });
  if (!LANGS.has(lang)) return NextResponse.json({ ok: false, error: "That language is not offered." }, { status: 400 });

  // "meeting:" keeps meeting summaries apart from programme rooms of the same name.
  const result = await getCatchUp(`meeting:${room}`, lang, () => meetingLines(room));
  const headers = { "Cache-Control": "no-store" };
  if (result.status !== "ready") return NextResponse.json({ ok: true, status: result.status }, { headers });
  const c = result.catchUp;
  return NextResponse.json(
    { ok: true, status: "ready", lang: c.lang, summary: c.summary, points: c.points, minutes: c.minutes, at: c.at },
    { headers },
  );
}

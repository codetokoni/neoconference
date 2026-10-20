import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { voiceClip } from "@/lib/voiceProfiles";
import { embedCaller } from "@/lib/partners/embedCaller";
import { hitRateLimit } from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/voice/speak  { room, identity, lang, text }
 *
 * One translated meeting sentence in the speaker's cloned voice, as MP3.
 * 204 (with X-Voice-Status saying why) when there is no clip to give — the
 * speaker has no voice, the language is not offered, the meeting's daily
 * cap is reached, or Cartesia failed — and the listener's page then speaks
 * the sentence with its own computer voice. Signed-in only, like the room.
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  // A partner widget's visitor: their embed session, for their own meeting only.
  const embed = userId ? null : await embedCaller(req);
  if (!userId && !embed) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (embed && !(await hitRateLimit(`speak:embed:${embed.identity}`, 120, 60)).ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  let body: { room?: unknown; identity?: unknown; lang?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const room = String(body.room ?? "").replace(/[^a-zA-Z0-9._#:-]/g, "").slice(0, 128);
  const identity = String(body.identity ?? "").slice(0, 128);
  const lang = String(body.lang ?? "").slice(0, 12);
  const text = String(body.text ?? "");
  if (!room || !identity || !lang || !text.trim()) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (embed && room !== embed.room) return NextResponse.json({ ok: false, error: "wrong_room" }, { status: 403 });

  const r = await voiceClip({ room, identity, lang, text });
  if (r.status !== "ok") {
    return new NextResponse(null, { status: 204, headers: { "X-Voice-Status": r.status, "Cache-Control": "no-store" } });
  }
  return new NextResponse(new Uint8Array(r.mp3), {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Voice-Status": r.cached ? "cached" : "made",
    },
  });
}

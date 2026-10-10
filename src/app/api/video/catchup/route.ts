import { NextResponse } from "next/server";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import { getCatchUp, roomLanguages, type TranscriptLine } from "@/lib/catchUp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "What did I miss?" for the programme player.
 *
 *   GET /api/video/catchup?room=X&lang=fr
 *     → { ok, status: "ready", summary, points, minutes, at }
 *     | { ok, status: "nothing_yet" | "busy" | "failed" }
 *
 * Public, like the player itself (the streaming link needs no sign-in).
 * Cost is bounded in getCatchUp: one shared summary per room and language,
 * remade at most every 2 minutes, and only for the languages the room
 * offers. A room with no transcript never reaches the AI.
 */

function room(req: Request): string {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

function workerBase(): string | null {
  const url = process.env.NEXT_PUBLIC_TRANSLATION_SSE || process.env.TRANSLATION_SSE || "";
  return url ? url.trim().replace(/\/$/, "") : null;
}

export async function GET(req: Request) {
  const r = room(req);
  const lang = (new URL(req.url).searchParams.get("lang") ?? "en").trim().toLowerCase().slice(0, 12);
  if (!roomLanguages(r).has(lang)) {
    return NextResponse.json({ ok: false, error: "That language is not offered in this programme." }, { status: 400 });
  }

  const base = workerBase();
  const fetchTranscript = async (): Promise<TranscriptLine[]> => {
    if (!base) return [];
    try {
      const res = await fetch(`${base}/transcript/${encodeURIComponent(r)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const j = (await res.json()) as { lines?: TranscriptLine[] };
      return Array.isArray(j.lines) ? j.lines : [];
    } catch {
      return [];
    }
  };

  const result = await getCatchUp(r, lang, fetchTranscript);
  const headers = { "Cache-Control": "no-store" };
  if (result.status !== "ready") return NextResponse.json({ ok: true, status: result.status }, { headers });
  const c = result.catchUp;
  return NextResponse.json(
    { ok: true, status: "ready", lang: c.lang, summary: c.summary, points: c.points, minutes: c.minutes, at: c.at },
    { headers },
  );
}

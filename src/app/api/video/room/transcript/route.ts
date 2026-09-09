import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the source-language transcript captured by the translation
 * worker's Deepgram pipeline for a room.
 *
 *   GET /api/video/room/transcript?room=neoconf         → everything so far
 *   GET /api/video/room/transcript?room=neoconf&since=42 → seq > 42 only
 *
 * The worker keeps a per-room ring buffer of finalised utterances
 * (see sse.ts `recordTranscript`). We proxy to it because the worker
 * lives on a separate host and the browser talks to same-origin the
 * app is served from anyway. If the worker is unreachable or hasn't
 * captured anything yet, we return an empty transcript so downstream
 * callers (accessibility overlay, archive page) don't need to
 * distinguish "no captions" from "worker down."
 *
 * Requires a signed-in Clerk account — same gate as every other
 * `/api/video/room/*` read.
 */

function normaliseRoom(req: Request): string {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

/**
 * Base URL of the translation worker's HTTP server. Same env the
 * client bundle uses to open its EventSource (`NEXT_PUBLIC_TRANSLATION_SSE`),
 * fallback to `TRANSLATION_SSE` for server-only overrides.
 */
function workerBase(): string | null {
  const url = process.env.NEXT_PUBLIC_TRANSLATION_SSE || process.env.TRANSLATION_SSE || "";
  return url ? url.trim().replace(/\/$/, "") : null;
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const room = normaliseRoom(req);
  const since = new URL(req.url).searchParams.get("since") ?? "";
  const base = workerBase();
  if (!base) {
    return NextResponse.json(
      { ok: true, room, count: 0, lines: [], workerConfigured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const target = `${base}/transcript/${encodeURIComponent(room)}${
      since ? `?since=${encodeURIComponent(since)}` : ""
    }`;
    // 4s cap: the worker keeps this in memory, the round trip is
    // dominated by geography. A slow worker shouldn't hang a
    // moderator's polling loop.
    const r = await fetch(target, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      return NextResponse.json(
        { ok: true, room, count: 0, lines: [], workerReachable: false, status: r.status },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const j = await r.json();
    return NextResponse.json(
      { ok: true, room, count: j.count ?? 0, lines: j.lines ?? [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: true,
        room,
        count: 0,
        lines: [],
        workerReachable: false,
        error: (e as Error).message || "fetch failed",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

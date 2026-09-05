import { NextResponse } from "next/server";
import { fetchSubtracks, SIMULCAST_MAIN, SIMULCAST_CHANNELS } from "@/lib/simulcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const main = new URL(req.url).searchParams.get("room")?.trim() || SIMULCAST_MAIN;

  try {
    const subs = await fetchSubtracks(main);
    const liveIds = new Set(
      subs.filter((b) => b.status === "broadcasting").map((b) => b.streamId),
    );

    const viewers = subs.reduce(
      (n, b) => n + (b.webRTCViewerCount ?? 0) + (b.hlsViewerCount ?? 0),
      0,
    );

    return NextResponse.json(
      {
        ok: true,
        main,
        live: liveIds.size > 0,
        viewers,
        channels: SIMULCAST_CHANNELS.map((c) => ({ id: c.id, live: liveIds.has(c.id) })),
        // any booth publishing into the group but missing from SIMULCAST_CHANNELS
        unknown: subs
          .filter(
            (b) =>
              b.status === "broadcasting" &&
              !SIMULCAST_CHANNELS.some((c) => c.id === b.streamId),
          )
          .map((b) => b.streamId),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        main,
        live: false,
        viewers: 0,
        channels: [],
        unknown: [],
        error: (e as Error).message,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}

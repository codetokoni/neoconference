import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import {
  fetchSubtracks,
  isBroadcasting,
  SIMULCAST_MAIN,
  SIMULCAST_CHANNELS,
  featuredKey,
  type FeaturedState,
} from "@/lib/simulcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const main = new URL(req.url).searchParams.get("room")?.trim() || SIMULCAST_MAIN;

  try {
    const [subs, featuredRaw] = await Promise.all([
      fetchSubtracks(main),
      kv.get<FeaturedState>(featuredKey(main)).catch(() => null),
    ]);
    const liveIds = new Set(
      subs.filter((b) => b.status === "broadcasting").map((b) => b.streamId),
    );

    const viewers = subs.reduce(
      (n, b) => n + (b.webRTCViewerCount ?? 0) + (b.hlsViewerCount ?? 0),
      0,
    );

    // Verify the featured stream still exists. Participant streams live in
    // the roomMainTrack group ("<main>-room"), so `subs` above doesn't
    // include them — hit AMS directly and self-heal if it has gone away.
    // Without this a mobile publisher that dropped off (screen lock, WS
    // timeout) would leave the pointer set forever and every viewer would
    // sit on a black picture behind an ON AIR badge that lies.
    let featured: FeaturedState | null = featuredRaw ?? null;
    if (featured) {
      const alive = await isBroadcasting(featured.streamId);
      if (!alive) {
        await kv.del(featuredKey(main)).catch(() => {});
        featured = null;
      }
    }

    return NextResponse.json(
      {
        ok: true,
        main,
        live: liveIds.size > 0,
        viewers,
        featured,
        channels: SIMULCAST_CHANNELS.map((c) => ({ id: c.id, live: liveIds.has(c.id) })),
        // any booth publishing into the group but missing from SIMULCAST_CHANNELS
        unknown: subs
          .filter(
            (b) =>
              b.status === "broadcasting" &&
              b.streamId !== main &&
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
        featured: null,
        error: (e as Error).message,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}

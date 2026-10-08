import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import {
  fetchSubtracks,
  isBroadcasting,
  isSurelyBroadcasting,
  videoChannelForRoom,
  SIMULCAST_MAIN,
  SIMULCAST_CHANNELS,
  featuredKey,
  type FeaturedState,
} from "@/lib/simulcast";
import { roomMainTrack } from "@/lib/participantCodes";
import {
  ensureRoomBroadcastsInBackground,
  relinkVideoSubtrackThrottled,
} from "@/lib/amsMainTrack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const room = new URL(req.url).searchParams.get("room")?.trim() || SIMULCAST_MAIN;
  // AMS knows the main-track wrapper as `<room>-room`, not the bare
  // room slug. Pre-transforming here so both fetchSubtracks and the
  // "unknown streams" filter agree on the same id — otherwise the
  // subtracks lookup 404s, the fallback filter matches nothing, and
  // the audience-facing dashboard reports `live: false` even when a
  // proper RTMP publisher (OBS, vMix) is pushing to <room>-video.
  const mainTrack = roomMainTrack(room);

  try {
    const [subs, featuredRaw] = await Promise.all([
      fetchSubtracks(mainTrack),
      kv.get<FeaturedState>(featuredKey(room)).catch(() => null),
    ]);
    const liveIds = new Set(
      subs.filter((b) => b.status === "broadcasting").map((b) => b.streamId),
    );

    // The programme can be live outside the room's group: on 8 Oct 2026
    // vMix/OBS was pushing <room>-video over RTMP with no
    // mainTrackStreamId while <room>-room sat "finished", so the group
    // had no subtracks and every viewer was told the broadcast hadn't
    // started. Ask about the programme stream itself; the player then
    // plays it over HLS.
    const videoId = videoChannelForRoom(room).id;
    if (!liveIds.has(videoId) && (await isSurelyBroadcasting(videoId))) {
      liveIds.add(videoId);
      // And put it back in the group, so the next poll's WebRTC plays it
      // (an encoder reconnecting drops the link again; this keeps undoing
      // that). Awaited: work left running after the response never runs.
      await relinkVideoSubtrackThrottled(room);
    }

    // Self-heal the room's AMS broadcast objects (wrapper + video
    // subtrack) if AMS has GC'd them. `subs` being empty is the same
    // shape as the mid-event outage on 2026-09-10 where `neoconf-room`
    // had vanished, and the same shape as the missing `neoconf-video`
    // that made the recording toggle fail after that. Fire in the
    // background (debounced 30s/room in the helper) so the status
    // poll itself never blocks on a create call.
    if (subs.length === 0) {
      ensureRoomBroadcastsInBackground(room);
    }

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
        await kv.del(featuredKey(room)).catch(() => {});
        featured = null;
      }
    }

    return NextResponse.json(
      {
        ok: true,
        main: room,
        live: liveIds.size > 0,
        viewers,
        featured,
        channels: SIMULCAST_CHANNELS.map((c) => ({ id: c.id, live: liveIds.has(c.id) })),
        // any booth publishing into the group but missing from SIMULCAST_CHANNELS
        unknown: subs
          .filter(
            (b) =>
              b.status === "broadcasting" &&
              b.streamId !== mainTrack &&
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
        main: room,
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

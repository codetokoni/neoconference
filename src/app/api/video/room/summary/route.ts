import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireRole } from "@/lib/roles";
import {
  SIMULCAST_MAIN,
  featuredKey,
  fetchSubtracks,
  type FeaturedState,
} from "@/lib/simulcast";
import {
  claimedCodes,
  listCodes,
  roomMainTrack,
} from "@/lib/participantCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kept in sync with /api/video/room's PER_SCREEN. */
const PER_SCREEN = 50;

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

async function guard() {
  const actor = await requireRole(["admin", "staff"]);
  return actor
    ? null
    : NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
}

/**
 * Aggregate roster + attendance numbers for the control-room hub. Returns
 * totals and a per-screen breakdown — no participant list. The name and
 * camera boards call the paginated /api/video/room for that.
 *
 * "38/50 live · 6 joined without camera · 6 never claimed" is exactly
 * what a producer needs ten minutes before doors. This endpoint is the
 * one call that answers it, so the hub can poll cheaply.
 */
export async function GET(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);

  const [codes, claimed, featured] = await Promise.all([
    listCodes(r),
    claimedCodes(r),
    kv.get<FeaturedState>(featuredKey(r)).catch(() => null),
  ]);

  const mainTrack = roomMainTrack(r);

  let liveIds = new Set<string>();
  try {
    const subs = await fetchSubtracks(mainTrack);
    liveIds = new Set(
      subs.filter((b) => b.status === "broadcasting").map((b) => b.streamId),
    );
  } catch {
    /* AMS unreachable — report roster with nobody live rather than 500 */
  }

  const totalSlots = codes.length;
  let liveCount = 0;
  let claimedNoCameraCount = 0;
  let neverClaimedCount = 0;

  const totalScreens = Math.max(1, Math.ceil(totalSlots / PER_SCREEN));
  const screenBlocks = Array.from({ length: totalScreens }, (_, i) => {
    const screen = i + 1;
    return {
      screen,
      from: (screen - 1) * PER_SCREEN + 1,
      to: screen * PER_SCREEN,
      total: 0,
      live: 0,
      claimedNoCamera: 0,
      neverClaimed: 0,
    };
  });

  codes.forEach((c) => {
    const isLive = liveIds.has(c.streamId);
    const isClaimed = claimed.has(c.code);
    if (isLive) liveCount += 1;
    else if (isClaimed) claimedNoCameraCount += 1;
    else neverClaimedCount += 1;

    const idx = Math.min(totalScreens - 1, Math.floor((c.slot - 1) / PER_SCREEN));
    const block = screenBlocks[idx];
    block.total += 1;
    if (isLive) block.live += 1;
    else if (isClaimed) block.claimedNoCamera += 1;
    else block.neverClaimed += 1;
  });

  // Codes are minted with the room's prefix and formatted as PREFIX-NN,
  // so splitting any code on "-" recovers the shared prefix without a
  // second KV read for the prefix key.
  const codePrefix = codes[0]?.code.split("-")[0] ?? "";

  return NextResponse.json(
    {
      ok: true,
      room: r,
      mainTrack,
      totalSlots,
      codePrefix,
      counts: {
        live: liveCount,
        claimedNoCamera: claimedNoCameraCount,
        neverClaimed: neverClaimedCount,
      },
      screens: totalScreens,
      perScreen: PER_SCREEN,
      screenBlocks,
      featured: featured ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

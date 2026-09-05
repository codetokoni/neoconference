import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireRole } from "@/lib/roles";
import {
  AMS_REST,
  SIMULCAST_MAIN,
  featuredKey,
  fetchSubtracks,
  type FeaturedState,
} from "@/lib/simulcast";
import {
  claimedCodes,
  listCodes,
  releaseCode,
  roomMainTrack,
} from "@/lib/participantCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tiles per screen. 50 inbound streams is already an operator's whole budget. */
export const PER_SCREEN = 50;

export interface RoomLayout {
  /** Stream ids in display order. Anything unlisted falls in by slot. */
  order: string[];
  /** Stream ids the operator has pushed off this screen. */
  hidden: string[];
}

const layoutKey = (room: string, screen: number) =>
  `neo:video:layout:${room}:${screen}`;

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

function screenNo(req: Request) {
  const n = Number(new URL(req.url).searchParams.get("screen") ?? 1);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? Math.floor(n) : 1;
}

async function guard() {
  const actor = await requireRole(["admin", "staff"]);
  return actor
    ? null
    : NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
}

/**
 * Everything one control-room screen needs in a single call: who exists, who
 * is actually publishing, who is on air, and how this screen is arranged.
 *
 * Layout is shared rather than per-operator on purpose — a screen is a
 * physical output someone is projecting, so it has to look the same to
 * everyone who touches it.
 */
export async function GET(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);
  const screen = screenNo(req);

  const [codes, claimed, layout, featuredRaw] = await Promise.all([
    listCodes(r),
    claimedCodes(r),
    kv.get<RoomLayout>(layoutKey(r, screen)),
    kv.get<FeaturedState>(featuredKey(r)).catch(() => null),
  ]);

  let liveIds = new Set<string>();
  let subsFetched = false;
  try {
    const subs = await fetchSubtracks(roomMainTrack(r));
    liveIds = new Set(
      subs.filter((b) => b.status === "broadcasting").map((b) => b.streamId),
    );
    subsFetched = true;
  } catch {
    /* AMS unreachable — report the roster with nobody live rather than 500 */
  }

  // Self-heal a stale featured pointer whose publisher has gone away without
  // clearing KV — matches the status route so the ON AIR badge and the
  // dashboard picture agree. Only clear when we actually reached AMS: if
  // the fetch failed above we can't tell alive from unreachable.
  let featured: FeaturedState | null = featuredRaw ?? null;
  if (featured && subsFetched && !liveIds.has(featured.streamId)) {
    await kv.del(featuredKey(r)).catch(() => {});
    featured = null;
  }

  const from = (screen - 1) * PER_SCREEN + 1;
  const to = screen * PER_SCREEN;

  const participants = codes
    .filter((c) => c.slot >= from && c.slot <= to)
    .map((c) => ({
      slot: c.slot,
      name: c.name,
      code: c.code,
      streamId: c.streamId,
      live: liveIds.has(c.streamId),
      claimed: claimed.has(c.code),
    }));

  return NextResponse.json(
    {
      ok: true,
      room: r,
      screen,
      perScreen: PER_SCREEN,
      screens: Math.max(1, Math.ceil(codes.length / PER_SCREEN)),
      mainTrack: roomMainTrack(r),
      participants,
      layout: layout ?? { order: [], hidden: [] },
      featured,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Saves the arrangement of one screen. */
export async function PATCH(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);
  const screen = screenNo(req);

  let body: { order?: unknown; hidden?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const clean = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((x) => String(x).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128))
      .filter(Boolean)
      .slice(0, PER_SCREEN * 2);

  const layout: RoomLayout = { order: clean(body.order), hidden: clean(body.hidden) };
  await kv.set(layoutKey(r, screen), layout);

  return NextResponse.json({ ok: true, layout });
}

/**
 * Removes a participant: stops their broadcast at the server and frees the
 * code so it can be handed to someone else. Their browser will see the
 * publish end rather than silently keep a dead connection open.
 */
export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);
  const url = new URL(req.url);
  const streamId = (url.searchParams.get("streamId") ?? "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 128);
  const code = url.searchParams.get("code") ?? "";

  if (!streamId) {
    return NextResponse.json({ ok: false, error: "streamId required" }, { status: 400 });
  }

  let stopped = false;
  try {
    const res = await fetch(`${AMS_REST}/broadcasts/${encodeURIComponent(streamId)}`, {
      method: "DELETE",
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    stopped = res.ok;
  } catch {
    /* fall through — the claim still gets released */
  }

  if (code) await releaseCode(r, code);

  return NextResponse.json({ ok: true, stopped, streamId });
}

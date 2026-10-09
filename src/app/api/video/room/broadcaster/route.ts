// /api/video/room/broadcaster?room=<slug> — which stream every viewer of
// the room watches (src/lib/videoBroadcaster.ts). Room admins only, the same
// check as the roster routes.
//
//   GET     the current broadcaster and whether it is live
//   POST    { streamId, label? } — the room's programme or one of its
//           participant slots; anything else is refused (400)
//   DELETE  back to the room's programme feed

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN, isSurelyBroadcasting } from "@/lib/simulcast";
import { isVideoRoomAdmin } from "@/lib/videoAdmin";
import { clearBroadcaster, getBroadcaster, isRoomBroadcastStream, setBroadcaster } from "@/lib/videoBroadcaster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

async function guard(): Promise<{ userId: string } | NextResponse> {
  const actor = await requireRole(["admin", "staff"]);
  if (!actor || !(await isVideoRoomAdmin())) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return { userId: actor.userId };
}

async function answer(r: string) {
  const b = await getBroadcaster(r);
  return NextResponse.json({ ok: true, room: r, broadcaster: { ...b, live: await isSurelyBroadcasting(b.streamId) } });
}

export async function GET(req: Request) {
  const g = await guard();
  if (g instanceof NextResponse) return g;
  return answer(room(req));
}

export async function POST(req: Request) {
  const g = await guard();
  if (g instanceof NextResponse) return g;
  const r = room(req);
  let body: { streamId?: unknown; label?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Send JSON." }, { status: 400 });
  }
  if (!isRoomBroadcastStream(r, body.streamId)) {
    return NextResponse.json(
      { ok: false, error: `Choose ${r}-video or one of this room's participant slots (${r}-p01…).` },
      { status: 400 },
    );
  }
  await setBroadcaster(r, body.streamId, typeof body.label === "string" ? body.label : "", g.userId);
  return answer(r);
}

export async function DELETE(req: Request) {
  const g = await guard();
  if (g instanceof NextResponse) return g;
  const r = room(req);
  await clearBroadcaster(r);
  return answer(r);
}

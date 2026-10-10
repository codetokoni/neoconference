import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import { getJoinLock, setJoinLock } from "@/lib/joinLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Locks or opens a room's join page.
 *
 *   GET  /api/video/room/join-lock?room=X                    → { locked, at }
 *   POST /api/video/room/join-lock?room=X  { locked: bool }  → the new state
 *
 * Same gate as the other moderator writes: any signed-in account. The
 * join page reads the state from GET /api/video/join, which is public.
 */

function room(req: Request): string {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const lock = await getJoinLock(room(req));
  return NextResponse.json({ ok: true, locked: lock.locked, at: lock.at }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { locked?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
  if (typeof body.locked !== "boolean") {
    return NextResponse.json({ ok: false, error: "locked must be true or false" }, { status: 400 });
  }

  const r = room(req);
  const lock = await setJoinLock(r, body.locked, userId);
  console.info(
    "[video-join] " + JSON.stringify({ room: r, outcome: lock.locked ? "join_locked" : "join_opened", by: userId }),
  );
  return NextResponse.json({ ok: true, locked: lock.locked, at: lock.at });
}

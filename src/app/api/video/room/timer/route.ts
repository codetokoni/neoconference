import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import {
  clearTimer,
  getTimer,
  pauseTimer,
  resumeTimer,
  setTimer,
} from "@/lib/videoTimer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Programme-feed countdown / segment timer.
 *
 *   GET    /api/video/room/timer?room=X               → current state
 *   POST   /api/video/room/timer?room=X               → set a new timer
 *   PATCH  /api/video/room/timer?room=X&action=pause  → freeze remaining
 *                                                    &action=resume  → keep going
 *   DELETE /api/video/room/timer?room=X               → remove the timer
 *
 * GET is PUBLIC so the audience-facing programme feed can render the
 * overlay without a Clerk session. POST / PATCH / DELETE require any
 * signed-in Clerk account — same gate as moderator-tier writes.
 * Everything mutating routes through the videoTimer helpers so the
 * "compute remaining from startedAt+duration" model stays in one
 * place.
 */

function normaliseRoom(req: Request): string {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

async function guard() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(req: Request) {
  const timer = await getTimer(normaliseRoom(req));
  return NextResponse.json(
    { ok: true, timer },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const room = normaliseRoom(req);
  let body: {
    label?: unknown;
    durationMs?: unknown;
    seconds?: unknown;
    minutes?: unknown;
    expiresBehaviour?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  // Accept either a raw ms value, or (minutes, seconds) for the UI.
  let durationMs = 0;
  if (typeof body.durationMs === "number" && Number.isFinite(body.durationMs)) {
    durationMs = body.durationMs;
  } else {
    const m = Number(body.minutes ?? 0);
    const s = Number(body.seconds ?? 0);
    if (Number.isFinite(m) && Number.isFinite(s)) {
      durationMs = (Math.floor(m) * 60 + Math.floor(s)) * 1000;
    }
  }
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 24 * 60 * 60 * 1000) {
    return NextResponse.json(
      { ok: false, error: "Duration must be between 1 second and 24 hours." },
      { status: 400 },
    );
  }

  const label = typeof body.label === "string" ? body.label.trim() : "";
  const expiresBehaviour: "hold" | "hide" =
    body.expiresBehaviour === "hide" ? "hide" : "hold";

  const timer = await setTimer(room, {
    label: label || "Segment",
    durationMs,
    expiresBehaviour,
  });
  return NextResponse.json({ ok: true, timer });
}

export async function PATCH(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const room = normaliseRoom(req);
  const action = new URL(req.url).searchParams.get("action");
  if (action === "pause") {
    const timer = await pauseTimer(room);
    return NextResponse.json({ ok: true, timer });
  }
  if (action === "resume") {
    const timer = await resumeTimer(room);
    return NextResponse.json({ ok: true, timer });
  }
  return NextResponse.json(
    { ok: false, error: "action must be 'pause' or 'resume'." },
    { status: 400 },
  );
}

export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  await clearTimer(normaliseRoom(req));
  return NextResponse.json({ ok: true });
}

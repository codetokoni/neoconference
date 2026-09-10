import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import { isVideoRoomAdmin } from "@/lib/videoAdmin";
import { ensureRoomBroadcastsInBackground } from "@/lib/amsMainTrack";
import {
  deleteRecording,
  getRecordingState,
  listRecordings,
  setRecording,
  type RecordType,
} from "@/lib/videoRecording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Programme-feed recording control for one room.
 *
 *   GET    /api/video/recording?room=X   → current state + list of VODs
 *   POST   /api/video/recording?room=X   → { recordType: "MP4" | "NONE" }
 *   DELETE /api/video/recording?room=X&vodId=abc → delete one recording
 *
 * Admin-only. Recording toggles storage cost on the AMS box and the
 * VOD files are distribution artefacts — the same rank as the
 * roster upload / download that lives on the video admin allowlist,
 * so gate on isVideoRoomAdmin rather than just any signed-in Clerk.
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
  if (!(await isVideoRoomAdmin())) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const room = normaliseRoom(req);

  try {
    // Fetch both in parallel — the state and the list are independent
    // AMS reads. Either can fail on its own; the response returns
    // whichever succeeded so the UI still has something to render.
    const [stateResult, listResult] = await Promise.allSettled([
      getRecordingState(room),
      listRecordings(room),
    ]);
    // Self-heal: if AMS has no broadcast entity for this room's video
    // subtrack, pre-create it (and the wrapper) in the background so
    // the operator's next click actually works. Debounced 30s/room in
    // the helper, so a poll storm doesn't hammer AMS.
    if (stateResult.status === "fulfilled" && stateResult.value === null) {
      ensureRoomBroadcastsInBackground(room);
    }
    return NextResponse.json({
      ok: true,
      room,
      state:
        stateResult.status === "fulfilled" ? stateResult.value : null,
      stateError:
        stateResult.status === "rejected"
          ? (stateResult.reason as Error).message ?? "state fetch failed"
          : null,
      vods: listResult.status === "fulfilled" ? listResult.value : [],
      vodsError:
        listResult.status === "rejected"
          ? (listResult.reason as Error).message ?? "vods fetch failed"
          : null,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message ?? "AMS unreachable" },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const room = normaliseRoom(req);

  let body: { recordType?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
  const raw = String(body.recordType ?? "").toUpperCase();
  if (raw !== "MP4" && raw !== "NONE" && raw !== "WEBM" && raw !== "HLS") {
    return NextResponse.json(
      { ok: false, error: "recordType must be MP4, WEBM, HLS, or NONE." },
      { status: 400 },
    );
  }
  const recordType = raw as RecordType;

  try {
    const state = await setRecording(room, recordType);
    if (!state) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "AMS has no record of a broadcast for this room yet. Start the programme feed once, then toggle recording.",
        },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, state });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message ?? "AMS unreachable" },
      { status: 502 },
    );
  }
}

export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const vodId = new URL(req.url).searchParams.get("vodId")?.trim();
  if (!vodId) {
    return NextResponse.json({ ok: false, error: "vodId required." }, { status: 400 });
  }
  try {
    const removed = await deleteRecording(vodId);
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message ?? "AMS unreachable" },
      { status: 502 },
    );
  }
}

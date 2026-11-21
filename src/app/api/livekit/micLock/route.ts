// src/app/api/livekit/micLock/route.ts
//
// "Mute everyone" / "Unmute everyone": the meeting-wide microphone lock
// (src/lib/micLock.ts).
//
// GET  ?room=<slug>                     -> { locked }
// POST { roomName, locked: boolean }    -> { ok, locked, changed, failed }
//
// POST is participant:muteAll — owner, host or moderator, checked against
// the caller's current role on every call. The lock is stored on the event
// first (so a token issued from now on carries it), then every participant
// in the room is brought into line and the room's metadata says which way
// it went, so every host's and moderator's button shows the same state. If
// LiveKit cannot be reached the stored lock is put back and the caller is
// told: their button keeps showing the last state that took effect.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import { MUTE_CONCURRENCY, runLimited } from "@/lib/muteAll";
import { isMicLocked, planMicLock, roomMetadataWithLock, type MicLock } from "@/lib/micLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * LiveKit's client has no timeout of its own: with the server not
 * answering, the host's button said "busy" for ever. Each call gets this long.
 */
const LIVEKIT_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("livekit_timeout")), LIVEKIT_TIMEOUT_MS);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

function httpUrlFromWs(ws: string | undefined): string {
  if (!ws) return "";
  return ws.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const room = (new URL(req.url).searchParams.get("room") || "").trim();
  if (!room) return NextResponse.json({ error: "missing_room" }, { status: 400 });
  const event = await eventStore.bySlug(room);
  if (!event) return NextResponse.json({ error: "event_not_found" }, { status: 404 });
  return NextResponse.json({ locked: isMicLocked(event) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  let body: { roomName?: unknown; locked?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const roomName = typeof body.roomName === "string" ? body.roomName.trim() : "";
  if (!roomName) return NextResponse.json({ error: "missing_room" }, { status: 400 });
  if (typeof body.locked !== "boolean") return NextResponse.json({ error: "missing_locked" }, { status: 400 });
  const locked = body.locked;

  const event = await eventStore.bySlug(roomName);
  if (!event) return NextResponse.json({ error: "event_not_found" }, { status: 404 });

  const gate = await authorize(event, "participant:muteAll");
  if (!gate.ok) return gate.response;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const apiUrl = httpUrlFromWs(process.env.LIVEKIT_WS_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL);
  if (!apiKey || !apiSecret || !apiUrl) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const before = event.micLock;
  const lock: MicLock | undefined = locked
    ? { locked: true, by: gate.actor.userId || "", at: new Date().toISOString() }
    : undefined;
  await eventStore.update(event.id, (prev) => ({ ...prev, micLock: lock, updatedAt: new Date().toISOString() }));

  const svc = new RoomServiceClient(apiUrl, apiKey, apiSecret);
  let list;
  try {
    list = await withTimeout(svc.listParticipants(roomName));
  } catch (e) {
    // Nobody in the room yet is not a failure: the lock waits in the event
    // for the first token. LiveKit unreachable is, and is undone.
    const msg = String((e as Error)?.message || e);
    if (/not.?found|does not exist/i.test(msg)) {
      return NextResponse.json({ ok: true, locked, changed: 0, failed: 0 });
    }
    console.error("[micLock] listParticipants failed", e);
    await eventStore.update(event.id, (prev) => ({ ...prev, micLock: before, updatedAt: new Date().toISOString() }));
    return NextResponse.json(
      {
        error: "livekit_unavailable",
        message: locked
          ? "Couldn't mute everyone. The meeting server didn't answer. Try again."
          : "Couldn't unmute everyone. The meeting server didn't answer. Try again.",
        locked: isMicLocked({ micLock: before }),
      },
      { status: 502 },
    );
  }

  const jobs = planMicLock(list, locked);
  const result = await runLimited(jobs, MUTE_CONCURRENCY, async (job) => {
    try {
      await withTimeout(svc.updateParticipant(roomName, job.identity, undefined, job.permission));
    } catch (e) {
      // Usually someone who left between the list and the update; anyone
      // who comes back gets the lock from their token.
      console.warn("[micLock] updateParticipant failed", job.identity, e);
      throw e;
    }
  });

  // Every host's and moderator's button follows this, not its own click.
  try {
    const rooms = await withTimeout(svc.listRooms([roomName]));
    await withTimeout(svc.updateRoomMetadata(roomName, roomMetadataWithLock(rooms[0]?.metadata, locked)));
  } catch (e) {
    console.warn("[micLock] updateRoomMetadata failed", e);
  }

  console.info(
    "[micLock] done",
    JSON.stringify({ room: roomName, locked, participants: list.length, changed: result.ok, failed: result.failed }),
  );
  return NextResponse.json({ ok: true, locked, changed: result.ok, failed: result.failed });
}

// src/app/api/admin/cleanup-stuck-events/route.ts
//
// One-time backfill cleanup for events stuck in 'live' state because their
// LiveKit room ended before the room_finished webhook was wired up (PR fix:
// livekit-room-finished-webhook). Admin-gated, POST only.
//
// Algorithm:
//   1. List all events; filter to state === 'live' AND updatedAt older than
//      24 hours.
//   2. ONE call to RoomServiceClient.listRooms() to get every active LiveKit
//      room across the project. Build a Set of active room names.
//   3. For each candidate: if its livekitRoom is NOT in the active set, the
//      LiveKit room is gone -> transition to 'ended' with endedAt =
//      ev.updatedAt (best honest proxy; we don't know the real end time).
//   4. Return a summary: { scanned, cleaned, skipped, stillActive }.
//
// Once the webhook has been running for a while and there are no more stuck
// events, this endpoint can be removed in a follow-up PR.

import { NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { requireRole } from "@/lib/roles";
import { eventStore } from "@/lib/eventStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

interface CleanupResult {
  scanned: number;
  cleaned: number;
  skipped: number;
  stillActive: number;
  cleanedRooms: string[];
  stillActiveRooms: string[];
}

export async function POST() {
  const caller = await requireRole(["admin"]);
  if (!caller) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl =
    process.env.NEXT_PUBLIC_LIVEKIT_URL ||
    process.env.LIVEKIT_WS_URL ||
    process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !wsUrl) {
    return NextResponse.json({ error: "livekit_misconfigured" }, { status: 500 });
  }

  const httpUrl = wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);

  const all = await eventStore.listAll();
  const cutoffMs = Date.now() - STUCK_THRESHOLD_MS;

  // Candidates: stuck in 'live' for > 24h.
  const candidates = all.filter((ev) => {
    if (ev.state !== "live") return false;
    const u = Date.parse(ev.updatedAt || "");
    if (!Number.isFinite(u)) return false;
    return u < cutoffMs;
  });

  let activeRoomNames: Set<string>;
  try {
    const rooms = await svc.listRooms();
    activeRoomNames = new Set(
      (rooms || []).map((r) => (r.name || "").toLowerCase()).filter((n) => n.length > 0)
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "livekit_listrooms_failed", detail: msg }, { status: 502 });
  }

  const result: CleanupResult = {
    scanned: candidates.length,
    cleaned: 0,
    skipped: 0,
    stillActive: 0,
    cleanedRooms: [],
    stillActiveRooms: [],
  };

  for (const ev of candidates) {
    const roomName = (ev.livekitRoom || "").toLowerCase();
    if (roomName && activeRoomNames.has(roomName)) {
      result.stillActive += 1;
      result.stillActiveRooms.push(ev.livekitRoom);
      continue;
    }
    try {
      await eventStore.update(ev.id, (prev) => ({
        ...prev,
        state: "ended",
        endedAt: prev.endedAt || prev.updatedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      result.cleaned += 1;
      result.cleanedRooms.push(ev.livekitRoom);
    } catch (e) {
      result.skipped += 1;
      // eslint-disable-next-line no-console
      console.warn("[cleanup-stuck-events] update failed for", ev.id, e);
    }
  }

  return NextResponse.json({ ok: true, ...result });
}

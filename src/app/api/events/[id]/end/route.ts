// src/app/api/events/[id]/end/route.ts
// FRS §6: Owner+Host may end the meeting for everyone. Marks the event ended,
// force-disconnects any active LiveKit participants, then kicks off a best-
// effort background AI summary so the host gets a recap automatically.
//
// Path param may be either the event id or the event slug — mirrors the same
// fallthrough used by /api/events/[id]/roles so in-room controls that only
// hold the slug can hit this route without a lookup.

import { NextResponse, type NextRequest } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { eventStore } from "@/lib/eventStore";
import { authorize } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ev = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!ev) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const gate = await authorize(ev, "meeting:end");
  if (!gate.ok) return gate.response;
  const next = await eventStore.update(ev.id, (prev) => ({
    ...prev,
    state: "ended",
    endedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  // Force-disconnect any active LiveKit participants. Abrupt (no graceful
  // "meeting ended" message) — adding a graceful toast/redirect requires a
  // parallel sendData + client handler in the room page. Out of scope here.
  try {
    const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (wsUrl && apiKey && apiSecret) {
      const httpUrl = wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
      const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
      await svc.deleteRoom(ev.livekitRoom);
    }
  } catch (e) {
    console.warn("[events/end] deleteRoom failed:", e);
  }

  // Fire-and-forget: ask the summary endpoint to generate a recap.
  // We intentionally do not await this so the response stays fast.
  try {
    const proto = req.headers.get("x-forwarded-proto") || "https";
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (host) {
      const url = `${proto}://${host}/api/events/${ev.id}/summary`;
      const cookie = req.headers.get("cookie") || "";
      // No await on purpose.
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ trigger: "event-end" }),
      }).catch(() => {});
      // Also kick off chapter derivation (best-effort)
      const chaptersUrl = `${proto}://${host}/api/events/${ev.id}/chapters`;
      fetch(chaptersUrl, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
      }).catch(() => {});
    }
  } catch {
    // Ignore: summary is best-effort.
  }

  return NextResponse.json({ ok: true, event: next });
}



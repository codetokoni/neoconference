// src/app/api/events/[id]/start/route.ts
// Flip a scheduled/ended event to 'live' so the public landing page
// stops showing the countdown and renders the "Join live room" CTA.
//
// Authorization: "meeting:start" — RANK.host, matching /end. Owner,
// host, and cohost can all start (or restart) the room, so a recurring
// host / trusted moderator promoted to host can open the meeting even
// when the owner isn't online. Moderator (below host) still can't —
// gate lives in permissions.ts.
//
// POST /api/events/<id>/start
//   200 { ok: true, event }
//   401 unauthorized | 403 forbidden | 404 not_found | 409 invalid_state

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { authorize } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const gate = await authorize(ev, "meeting:start");
  if (!gate.ok) return gate.response;

  // Allow start from scheduled or waiting; idempotent if already live.
  // 'ended' is intentionally allowed too — it's how a host restarts an
  // event they wrapped up too early (the FRS §... "re-open" case). The
  // update below just flips state=live again and does not touch
  // startedAt if it's already set, so attendance timelines stay
  // contiguous. 'archived' stays refused because it's a deletion state.
  // 'replay' also stays refused because it means recordings are being
  // served; re-opening it would confuse the replay UX.
  if (ev.state === "replay" || ev.state === "archived") {
    return NextResponse.json({ error: "invalid_state" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const next = await eventStore.update(ev.id, (prev) => ({
    ...prev,
    state: "live" as const,
    startedAt: prev.startedAt || now,
    updatedAt: now,
  }));

  return NextResponse.json({ ok: true, event: next });
}

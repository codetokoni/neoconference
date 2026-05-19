// src/app/api/events/[id]/start/route.ts
// Owner-only: flip a scheduled event to 'live' so the public landing page
// stops showing the countdown and renders the "Join live room" CTA.
//
// POST /api/events/<id>/start
//   200 { ok: true, event }
//   401 unauthorized | 403 forbidden | 404 not_found | 409 invalid_state

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { assertOwnerOrAdmin } from "@/lib/roles";

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
  const check = await assertOwnerOrAdmin(ev, userId);
  if (!check.ok)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Allow start from scheduled or waiting; idempotent if already live.
  if (ev.state === "ended" || ev.state === "replay" || ev.state === "archived") {
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

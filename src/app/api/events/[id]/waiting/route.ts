// src/app/api/events/[id]/waiting/route.ts
// Owner-only waiting-room moderation.
//   POST   { entryId, action: "admit" | "deny" } - update an entry status.
//   PUT    { entry: { id, name, email? } }       - public-facing: enqueue self.
// PUT is callable by signed-in users (not just owners) so attendees can knock.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import type { WaitingRoomEntry } from "@/types/event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ev.ownerUserId !== userId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: any = {};
  try { body = await req.json(); } catch {}
  const entryId = String(body.entryId || "");
  const action = body.action;
  if (!entryId || (action !== "admit" && action !== "deny")) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const next = await eventStore.update(ev.id, (prev) => {
    co
nst list = (prev.waitingRoom || []).map((e) =>
      e.id === entryId ? { ...e, status: action === "admit" ? "admitted" : "denied" } : e
    ) as WaitingRoomEntry[];
    return { ...prev, waitingRoom: list, updatedAt: new Date().toISOString() };
  });
  return NextResponse.json({ ok: true, event: next });
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch {}
  const name = String(body.name || "").trim().slice(0, 80);
  const email = typeof body.email === "string" ? String(body.email).trim().slice(0, 200) : undefined;
  if (!name) return NextResponse.json({ error: "missing_name" }, { status: 400 });

  const entry: WaitingRoomEntry = {
    id: userId,
    name,
    email,
    requestedAt: Date.now(),
    status: "pending",
  };

  // If owner has waiting room disabled, auto-admit.
  if (!ev.waitingRoomEnabled) entry.status = "admitted";

  const next = await eventStore.update(ev.id, (prev) => {
    const others = (prev.waitingRoom || []).filter((e) => e.id !== entry.id);
    return { ...prev, waitingRoom: [...others, entry], updatedAt: new Date().toISOString() };
  });
  return NextResponse.json({ ok: true, status: entry.status, event: next });
}

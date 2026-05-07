// src/app/api/events/[id]/end/route.ts
// Owner-only POST. Marks an event as ended.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (ev.ownerUserId !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const next = await eventStore.update(ev.id, (prev) => ({
    ...prev,
    state: "ended",
    endedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  return NextResponse.json({ ok: true, event: next });
}

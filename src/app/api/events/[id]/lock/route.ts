// src/app/api/events/[id]/lock/route.ts
//
// POST — toggle FRS §12.8 meeting lock for an event.
//
// Body: { locked: boolean }
//
// When locked, the token route refuses new tokens for ordinary participants.
// Elevated roles (owner, host, cohost) can still enter so someone always
// remains able to flip the lock back off or admit specific people.
//
// Authorization: meeting:edit (RANK.host).
// Path param: id or slug — same byId ?? bySlug fallthrough as /roles and /end.

import { NextResponse, type NextRequest } from "next/server";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  locked?: unknown;
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const event = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!event) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const gate = await authorize(event, "meeting:edit");
  if (!gate.ok) return gate.response;

  let body: Body;
  try {
    body = (await _req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.locked !== "boolean") {
    return NextResponse.json({ error: "invalid_locked" }, { status: 400 });
  }
  const locked = body.locked;

  await eventStore.update(event.id, (prev) => ({
    ...prev,
    isLocked: locked || undefined,
    updatedAt: new Date().toISOString(),
  }));

  return NextResponse.json({ ok: true, eventId: event.id, isLocked: locked });
}

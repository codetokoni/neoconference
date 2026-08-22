// src/app/api/events/[id]/route.ts
// Owner-only PATCH for editable event metadata.
// Whitelisted fields only: name, description, scheduledAt, visibility, password, waitingRoomEnabled.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { assertOwnerOrAdmin } from "@/lib/roles";
import { hashMeetingPassword } from "@/lib/eventPassword";
import type { EventVisibility, NeoEvent } from "@/types/event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VISIBILITIES: ReadonlyArray<EventVisibility> = ["public", "unlisted", "private"];

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const check = await assertOwnerOrAdmin(ev, userId);
  if (!check.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: any = {};
  try { body = await req.json(); } catch {}

  const patch: Partial<NeoEvent> = {};
  if (typeof body.name === "string") {
    const v = body.name.trim();
    if (v.length === 0 || v.length > 200) return NextResponse.json({ error: "invalid_name" }, { status: 400 });
    patch.name = v;
  }
  if (typeof body.description === "string") patch.description = body.description.slice(0, 4000);
  if (typeof body.scheduledAt === "string") {
    const v = body.scheduledAt.trim();
    if (v) {
      const d = new Date(v);
      if (isNaN(d.getTime())) return NextResponse.json({ error: "invalid_scheduledAt" }, { status: 400 });
      patch.scheduledAt = d.toISOString();
    } else {
      patch.scheduledAt = undefined;
    }
  }
  if (typeof body.visibility === "string" && VISIBILITIES.includes(body.visibility)) {
    patch.visibility = body.visibility;
  }
  // FRS §12.2: password persisted as an scrypt hash, not plaintext. An empty
  // input clears the field (hashMeetingPassword returns undefined).
  if (typeof body.password === "string") patch.password = hashMeetingPassword(body.password.slice(0, 80));
  // FRS §6: optional End Meeting PIN. Same hash treatment as password.
  // Enforce a 4-char minimum when set — anything shorter isn't a barrier.
  if (typeof body.endPin === "string") {
    const rawPin = body.endPin.trim().slice(0, 64);
    if (rawPin.length > 0 && rawPin.length < 4) {
      return NextResponse.json({ error: "pin_too_short" }, { status: 400 });
    }
    patch.endPin = hashMeetingPassword(rawPin);
  }
  if (typeof body.waitingRoomEnabled === "boolean") patch.waitingRoomEnabled = body.waitingRoomEnabled;

  // FRS §11 inactivity config: whole object PATCH-able. Individual fields
  // are validated so the client can't stash arbitrary data; unset means the
  // client falls through to its defaults.
  if (body.inactivity && typeof body.inactivity === "object") {
    const raw = body.inactivity as Record<string, unknown>;
    const next: NonNullable<NeoEvent["inactivity"]> = {};
    if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
    if (typeof raw.warningMs === "number" && Number.isFinite(raw.warningMs)) {
      next.warningMs = Math.max(30_000, Math.min(3_600_000, Math.floor(raw.warningMs)));
    }
    if (typeof raw.responseMs === "number" && Number.isFinite(raw.responseMs)) {
      next.responseMs = Math.max(10_000, Math.min(300_000, Math.floor(raw.responseMs)));
    }
    if (typeof raw.autoRemove === "boolean") next.autoRemove = raw.autoRemove;
    if (typeof raw.exemptAdmins === "boolean") next.exemptAdmins = raw.exemptAdmins;
    patch.inactivity = Object.keys(next).length > 0 ? next : undefined;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  const next = await eventStore.update(ev.id, (prev) => ({
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  }));
  return NextResponse.json({ ok: true, event: next });
}

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import { deleteParticipant, updateParticipant } from "@/lib/participantCodes";
import { isVideoRoomAdmin } from "@/lib/videoAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

async function guard() {
  const actor = await requireRole(["admin", "staff"]);
  if (!actor) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!(await isVideoRoomAdmin())) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * Edit one participant after roster upload. Body:
 *
 *   { slot: 7, name?: "New name", meta?: { condition: "New value", country: "" } }
 *
 * Empty-string meta values delete the key; missing keys are left alone.
 * `name` is trimmed; an empty string is ignored so the tile always has a
 * label to render. The code and streamId are never editable — a code is
 * a contract with the participant already carrying it.
 */
export async function PATCH(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);

  let body: { slot?: unknown; name?: unknown; meta?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const slot = Number(body.slot);
  if (!Number.isFinite(slot) || slot <= 0) {
    return NextResponse.json({ ok: false, error: "Bad slot." }, { status: 400 });
  }

  const patch: { name?: string; meta?: Record<string, string> } = {};
  if (typeof body.name === "string") patch.name = body.name.slice(0, 200);
  if (body.meta && typeof body.meta === "object") {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.meta as Record<string, unknown>)) {
      if (typeof k !== "string") continue;
      clean[k] = String(v ?? "").slice(0, 500);
    }
    patch.meta = clean;
  }

  const updated = await updateParticipant(r, slot, patch);
  if (!updated) {
    return NextResponse.json({ ok: false, error: "Slot not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, participant: updated });
}

/**
 * Remove one participant from the roster entirely. Query params:
 *
 *   /api/video/room/roster/participant?room=X&slot=7
 *
 * The code stops working immediately and any active claim on it is
 * released. Idempotent — deleting a missing slot returns ok:true so
 * a double-click on the delete button doesn't 404 the second time.
 */
export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);
  const slot = Number(new URL(req.url).searchParams.get("slot") ?? "");
  if (!Number.isFinite(slot) || slot <= 0) {
    return NextResponse.json({ ok: false, error: "Bad slot." }, { status: 400 });
  }

  const result = await deleteParticipant(r, slot);
  return NextResponse.json({ ok: true, deleted: result.deleted, slot });
}

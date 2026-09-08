import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import { listRosterBatches } from "@/lib/rosterStore";
import { isVideoRoomAdmin } from "@/lib/videoAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List every upload the admin has made for a room, in the order they
 * were uploaded. Each entry carries the original filename, the slot
 * range that upload wrote to, the row count, and the upload
 * timestamp. The client uses this to render a per-batch download list
 * on the admin hub, so an operator who uploaded three spreadsheets
 * can download three files back with each original layout preserved.
 *
 * Admin-only — the same allowlist that gates roster upload/download.
 */

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

export async function GET(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);
  const batches = await listRosterBatches(r);
  return NextResponse.json({ ok: true, batches });
}

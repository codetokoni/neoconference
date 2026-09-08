import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import { applyRoster, listCodes } from "@/lib/participantCodes";
import { buildRosterXlsx, parseRoster } from "@/lib/roster";
import { getRoom } from "@/lib/rooms";
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
  // Roster upload / download is admin-only — the codes it emits are
  // handed to participants and shouldn't be reachable by a moderator
  // with staff role.
  if (!(await isVideoRoomAdmin())) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * Upload a roster spreadsheet. Accepts multipart/form-data with a
 * single `file` field (xlsx or csv). Each row is applied to the room's
 * codes: NAME becomes the tile label, extra columns are kept as meta
 * for the eventual download round-trip.
 */
export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ ok: false, error: "No file uploaded." }, { status: 400 });
  }

  const appendField = form.get("append");
  const append =
    appendField === "1" || appendField === "true" || appendField === "on";

  const buffer = Buffer.from(await file.arrayBuffer());
  let rows: ReturnType<typeof parseRoster>;
  try {
    rows = parseRoster(buffer);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message || "Could not parse the file." },
      { status: 400 },
    );
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No rows with a NAME value were found." },
      { status: 400 },
    );
  }

  const { updated, created } = await applyRoster(r, rows, { append });
  return NextResponse.json({ ok: true, updated, created });
}

/**
 * Download the roster as xlsx. First row carries the room name and join
 * URL for a mail merge; the rest is one row per code with any meta
 * columns the upload contributed, plus a PASSCODE column.
 */
export async function GET(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);
  const codes = await listCodes(r);
  if (codes.length === 0) {
    return NextResponse.json({ ok: false, error: "No codes minted." }, { status: 404 });
  }

  const roomRecord = await getRoom(r);
  const roomName = roomRecord?.name ?? r;

  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const joinUrl = `${origin}/video/join?room=${encodeURIComponent(r)}`;

  const buffer = buildRosterXlsx(codes, { joinUrl, roomName });
  // Node's Buffer works at runtime but the dom Response body types
  // don't accept it directly — wrap in Uint8Array for a clean type.
  const body = new Uint8Array(buffer);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${r}-roster.xlsx"`,
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
    },
  });
}

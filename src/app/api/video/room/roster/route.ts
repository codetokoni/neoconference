import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import {
  applyRoster,
  listCodes,
  resetRosterMeta,
  wipeRoom,
} from "@/lib/participantCodes";
import {
  buildRosterXlsx,
  buildRosterXlsxFromTemplate,
  mergeRosterFiles,
  parseRoster,
} from "@/lib/roster";
import { loadRosterFile, saveRosterFile } from "@/lib/rosterStore";
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

  // Stash the original file bytes so the download can re-emit the
  // admin's own layout (columns, order, header case, banner rows,
  // sheet name, cell formatting) with current NAME + meta overlaid on
  // top. For append uploads we fold the new file's data rows into the
  // stored template rather than overwriting it, so the extended
  // roster keeps rendering in the operator's original shape.
  try {
    if (append) {
      const existing = await loadRosterFile(r);
      if (existing) {
        const merged = mergeRosterFiles(existing, buffer);
        await saveRosterFile(r, merged ?? buffer);
      } else {
        await saveRosterFile(r, buffer);
      }
    } else {
      await saveRosterFile(r, buffer);
    }
  } catch (e) {
    // Best-effort: a KV hiccup here shouldn't fail the upload — the
    // codes have already been applied and the download will fall back
    // to the derived layout.
    console.error("[video/room/roster] saveRosterFile failed:", e);
  }

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

  // Prefer the operator's own layout: overlay current NAME + meta onto
  // the stored upload template and add a PASSCODE column. Fall back to
  // the derived layout for rooms that never uploaded a template (or
  // whose template couldn't be parsed).
  let buffer: Buffer | null = null;
  try {
    const template = await loadRosterFile(r);
    if (template) buffer = buildRosterXlsxFromTemplate(template, codes);
  } catch (e) {
    console.error("[video/room/roster] template overlay failed:", e);
  }
  if (!buffer) buffer = buildRosterXlsx(codes, { joinUrl, roomName });
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

/**
 * Batch destructive actions on the roster. Query params:
 *
 *   /api/video/room/roster?room=X&scope=wipe   — remove every trace
 *   /api/video/room/roster?room=X&scope=names  — reset names/meta only
 *
 * `wipe` deletes codes, code prefix, featured pointer, preview pointer,
 * every screen's layout, every claim lock, the stored xlsx template,
 * and any queues on the room. Next upload starts on a fresh code
 * prefix; anyone still holding an old code from before the wipe finds
 * it no longer works.
 *
 * `names` keeps every code and slot exactly as-is, but resets each
 * tile's label to "Child N" and clears roster meta. Also drops the
 * stored xlsx template so the download reflects the reset state.
 * Participants who already have their code are unaffected.
 *
 * Admin-only, same as upload/download.
 */
export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);
  const scope = new URL(req.url).searchParams.get("scope");
  if (scope === "wipe") {
    await wipeRoom(r);
    return NextResponse.json({ ok: true, scope: "wipe" });
  }
  if (scope === "names") {
    const { reset } = await resetRosterMeta(r);
    return NextResponse.json({ ok: true, scope: "names", reset });
  }
  return NextResponse.json(
    { ok: false, error: "scope must be 'wipe' or 'names'." },
    { status: 400 },
  );
}

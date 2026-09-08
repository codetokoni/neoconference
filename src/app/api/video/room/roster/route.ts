import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import {
  applyRoster,
  listCodes,
  regenerateCodes,
  resetRosterMeta,
  wipeRoom,
} from "@/lib/participantCodes";
import {
  buildRosterXlsx,
  buildRosterXlsxFromTemplate,
  mergeRosterFiles,
  parseRoster,
} from "@/lib/roster";
import {
  getRosterBatchMeta,
  loadRosterBatch,
  loadRosterFile,
  saveRosterBatch,
  saveRosterFile,
} from "@/lib/rosterStore";
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

  const { updated, created, slotStart, slotEnd } = await applyRoster(r, rows, { append });

  // Stash the original file two ways:
  //
  //  1. As its own batch — so the download list can hand back this
  //     exact xlsx (with a PASSCODE column overlaid for its slot
  //     range) even after further uploads land on top. This is what
  //     makes "download the files like I uploaded them" work.
  //  2. As the legacy single merged file — feeds the no-`?batch`
  //     download path that pre-dates batches. Append uploads fold in
  //     so the merged view keeps growing; replace uploads overwrite.
  //
  // Both writes are best-effort: a KV hiccup here shouldn't fail the
  // upload, since the codes have already been applied and downloads
  // will fall back to the derived layout.
  const filename = (file instanceof File ? file.name : "") || "roster.xlsx";
  let savedBatch: string | null = null;
  try {
    const batch = await saveRosterBatch(r, buffer, {
      filename,
      slotStart,
      slotEnd,
      rowCount: rows.length,
    });
    savedBatch = batch.id;
  } catch (e) {
    console.error("[video/room/roster] saveRosterBatch failed:", e);
  }
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
    console.error("[video/room/roster] saveRosterFile failed:", e);
  }

  return NextResponse.json({
    ok: true,
    updated,
    created,
    slotStart,
    slotEnd,
    batch: savedBatch,
  });
}

/**
 * Download the roster as xlsx.
 *
 *   /api/video/room/roster?room=X                 → merged view
 *   /api/video/room/roster?room=X&batch=<id>      → one upload's own file
 *
 * With `batch`, we return the exact xlsx the admin uploaded for that
 * batch (same layout, sheet name, banner rows, column order, header
 * case), overlaying the current NAME + meta values for the batch's
 * slot range and appending a PASSCODE column. Post-upload edits from
 * RosterEditor still show up in the download.
 *
 * Without `batch`, we return the merged single-file view (fallback:
 * derived layout for rooms that never uploaded a template).
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

  const batchId = new URL(req.url).searchParams.get("batch");
  if (batchId) {
    const meta = await getRosterBatchMeta(r, batchId);
    if (!meta) {
      return NextResponse.json(
        { ok: false, error: "Batch not found." },
        { status: 404 },
      );
    }
    const template = await loadRosterBatch(r, batchId);
    if (!template) {
      return NextResponse.json(
        { ok: false, error: "Batch payload missing." },
        { status: 404 },
      );
    }
    // Only the codes inside this batch's slot range are overlaid —
    // otherwise a later batch's rows would leak into this one's
    // trailing-rows section.
    const scopedCodes = codes.filter(
      (c) => c.slot >= meta.slotStart && c.slot <= meta.slotEnd,
    );
    let batchBuffer: Buffer | null = null;
    try {
      batchBuffer = buildRosterXlsxFromTemplate(template, scopedCodes);
    } catch (e) {
      console.error("[video/room/roster] batch overlay failed:", e);
    }
    if (!batchBuffer) batchBuffer = template; // best-effort fallback

    const body = new Uint8Array(batchBuffer);
    // Sanitise filename for Content-Disposition: strip quotes and
    // control chars; browsers reject a header carrying them.
    const safeName = (meta.filename || `${r}-batch.xlsx`).replace(/["\\\r\n]/g, "_");
    const outName = safeName.replace(/\.xlsx?$/i, "") + "-with-codes.xlsx";
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${outName}"`,
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
      },
    });
  }

  // Merged view. Prefer the operator's own layout: overlay current
  // NAME + meta onto the stored upload template and add a PASSCODE
  // column. Fall back to the derived layout for rooms that never
  // uploaded a template (or whose template couldn't be parsed).
  let buffer: Buffer | null = null;
  try {
    const template = await loadRosterFile(r);
    if (template) buffer = buildRosterXlsxFromTemplate(template, codes);
  } catch (e) {
    console.error("[video/room/roster] template overlay failed:", e);
  }
  if (!buffer) buffer = buildRosterXlsx(codes, { joinUrl, roomName });
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
 * Destructive actions on the roster. Query params:
 *
 *   /api/video/room/roster?room=X&scope=wipe   — remove every trace
 *   /api/video/room/roster?room=X&scope=names  — reset names/meta only
 *   /api/video/room/roster?room=X&batch=<id>   — remove one upload
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
 * `batch=<id>` removes ONE upload's stored xlsx from the download
 * list — the participants that upload wrote to keep their codes and
 * names (those live in participantCodes, not the batch entry), only
 * the downloadable template is gone. Use it to prune stale uploads
 * from the download list without touching the roster itself.
 *
 * Admin-only, same as upload/download.
 */
export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);
  const search = new URL(req.url).searchParams;
  const batchId = search.get("batch");
  if (batchId) {
    const { deleteRosterBatch } = await import("@/lib/rosterStore");
    const removed = await deleteRosterBatch(r, batchId);
    return NextResponse.json({ ok: true, batch: batchId, removed });
  }
  const scope = search.get("scope");
  if (scope === "wipe") {
    await wipeRoom(r);
    return NextResponse.json({ ok: true, scope: "wipe" });
  }
  if (scope === "names") {
    const { reset } = await resetRosterMeta(r);
    return NextResponse.json({ ok: true, scope: "names", reset });
  }
  if (scope === "codes") {
    const { regenerated } = await regenerateCodes(r);
    return NextResponse.json({ ok: true, scope: "codes", regenerated });
  }
  return NextResponse.json(
    {
      ok: false,
      error: "scope must be 'wipe', 'names', or 'codes', or pass batch=<id>.",
    },
    { status: 400 },
  );
}

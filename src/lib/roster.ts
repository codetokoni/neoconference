import * as XLSX from "xlsx";
import type { ParticipantCode } from "@/lib/participantCodes";

/**
 * Roster round-trip.
 *
 * Admins arrive with a spreadsheet: S/N, NAME, plus any extra columns
 * they use to keep track of participants (COUNTRY, CONDITION, CONTACT,
 * whatever). We parse it, apply the names to the room's codes, keep the
 * extras as meta, and — critically — stash the original file bytes so
 * the download can re-emit the admin's own layout rather than a
 * derived one. `buildRosterXlsxFromTemplate` does that overlay; the
 * legacy `buildRosterXlsx` is the fallback for rooms that never
 * uploaded a template.
 */

export interface RosterRow {
  slot: number;
  name: string;
  meta: Record<string, string>;
}

const NAME_KEYS = ["full name", "fullname", "name", "participant", "child"];
const SN_KEYS = ["s/n", "sn", "s.n.", "s.n", "no", "no.", "num", "#", "id"];
const PASSCODE_KEYS = ["passcode", "code"];

/**
 * Parse the first sheet of an xlsx or csv buffer into a list of roster
 * rows. Header row is detected by looking for the first row (within the
 * first ten) that contains a NAME-shaped column, so admins can prepend
 * arbitrary title/URL rows and we still find the data.
 */
export function parseRoster(buffer: Buffer): RosterRow[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("The uploaded file has no sheets.");
  const ws = wb.Sheets[sheetName];
  const rows: (string | number | null | undefined)[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: "",
    raw: false,
  });

  let headerIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const candidate = rows[i].map((c) => String(c ?? "").trim().toLowerCase());
    if (candidate.some((c) => NAME_KEYS.includes(c) || c.includes("name"))) {
      headerIdx = i;
      headers = candidate;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(
      "Could not find a header row with a NAME column in the first ten rows.",
    );
  }

  const nameIdx = headers.findIndex((h) => NAME_KEYS.includes(h) || h.includes("name"));
  const snIdx = headers.findIndex((h) => SN_KEYS.includes(h));

  const out: RosterRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(row[nameIdx] ?? "").trim();
    if (!name) continue;

    const rawSlot = snIdx >= 0 ? Number(row[snIdx]) : NaN;
    const slot = Number.isFinite(rawSlot) && rawSlot > 0 ? Math.floor(rawSlot) : out.length + 1;

    const meta: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (!h || idx === nameIdx || idx === snIdx) return;
      if (h === "passcode" || h === "code") return; // dropped on re-upload
      const val = String(row[idx] ?? "").trim();
      if (val) meta[h] = val;
    });

    out.push({ slot, name, meta });
  }
  return out;
}

/**
 * Produce a downloadable xlsx: join URL at the top, then a header row
 * with every meta column that appears anywhere in the roster plus a
 * PASSCODE column, then one row per participant.
 *
 * Fallback used only when a room has no stored upload template (either
 * because it was minted without a roster upload, or its stored file was
 * cleared). New downloads for rooms that HAVE uploaded should route
 * through `buildRosterXlsxFromTemplate` so the operator's own layout
 * is preserved.
 */
export function buildRosterXlsx(
  codes: ParticipantCode[],
  opts: { joinUrl: string; roomName: string },
): Buffer {
  const metaKeys = new Set<string>();
  for (const c of codes) {
    if (c.meta) Object.keys(c.meta).forEach((k) => metaKeys.add(k));
  }
  const metaCols = Array.from(metaKeys);

  const header = ["S/N", "NAME", ...metaCols.map((k) => k.toUpperCase()), "PASSCODE"];
  const rows: (string | number)[][] = [];
  rows.push([`Room: ${opts.roomName}   Join: ${opts.joinUrl}`]);
  rows.push([]);
  rows.push(header);
  for (const c of codes) {
    rows.push([
      c.slot,
      c.name,
      ...metaCols.map((k) => c.meta?.[k] ?? ""),
      c.code,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Roster");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

/**
 * Describes where the data lives inside a workbook the admin uploaded:
 * which row is the header, which cell columns are name/S/N/passcode,
 * and the case-preserving header text for every other column.
 */
interface TemplateLayout {
  wb: XLSX.WorkBook;
  sheetName: string;
  ws: XLSX.WorkSheet;
  headerRow: number;
  headerCells: string[];
  nameCol: number;
  snCol: number;
  passcodeCol: number | null;
  metaByHeaderLower: Map<string, number>;
  dataStartRow: number;
  dataEndRow: number;
  dataColEnd: number;
}

function readLayout(buffer: Buffer): TemplateLayout | null {
  const wb = XLSX.read(buffer, { type: "buffer", cellStyles: true, cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return null;
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws["!ref"]) return null;
  const range = XLSX.utils.decode_range(ws["!ref"]);

  let headerRow = -1;
  let headerCells: string[] = [];
  const scanUntil = Math.min(range.s.r + 10, range.e.r);
  for (let r = range.s.r; r <= scanUntil; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row.push(cell && cell.v != null ? String(cell.v) : "");
    }
    const lowered = row.map((s) => s.trim().toLowerCase());
    if (lowered.some((s) => NAME_KEYS.includes(s) || s.includes("name"))) {
      headerRow = r;
      headerCells = row;
      break;
    }
  }
  if (headerRow === -1) return null;

  const lowered = headerCells.map((s) => s.trim().toLowerCase());
  const nameCol = lowered.findIndex((s) => NAME_KEYS.includes(s) || s.includes("name"));
  const snCol = lowered.findIndex((s) => SN_KEYS.includes(s));
  const passcodeCol = (() => {
    const i = lowered.findIndex((s) => PASSCODE_KEYS.includes(s));
    return i === -1 ? null : i;
  })();

  const metaByHeaderLower = new Map<string, number>();
  lowered.forEach((s, i) => {
    if (!s) return;
    if (i === nameCol || i === snCol) return;
    if (PASSCODE_KEYS.includes(s)) return;
    metaByHeaderLower.set(s, i);
  });

  // Where does the data end? Walk down from headerRow+1 until we run
  // out of populated rows in the name column — trailing blank rows in
  // the admin's file shouldn't turn into empty participant rows.
  let dataStartRow = headerRow + 1;
  let dataEndRow = headerRow;
  for (let r = dataStartRow; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: nameCol })];
    if (cell && String(cell.v ?? "").trim()) dataEndRow = r;
  }
  if (dataEndRow < dataStartRow) dataEndRow = headerRow; // no data yet

  return {
    wb,
    sheetName,
    ws,
    headerRow,
    headerCells,
    nameCol,
    snCol,
    passcodeCol,
    metaByHeaderLower,
    dataStartRow,
    dataEndRow,
    dataColEnd: range.e.c,
  };
}

function writeCell(ws: XLSX.WorkSheet, r: number, c: number, value: string | number): void {
  const addr = XLSX.utils.encode_cell({ r, c });
  const t = typeof value === "number" ? "n" : "s";
  ws[addr] = { t, v: value };
}

function extendRefTo(ws: XLSX.WorkSheet, r: number, c: number): void {
  const cur = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  if (r > cur.e.r) cur.e.r = r;
  if (c > cur.e.c) cur.e.c = c;
  ws["!ref"] = XLSX.utils.encode_range(cur);
}

/**
 * Re-emit the admin's uploaded xlsx with:
 *   - NAME + meta cells overlaid with the current values from
 *     participantCodes (so RosterEditor edits and post-upload renames
 *     show up),
 *   - a PASSCODE column added at the right edge (reusing an existing
 *     PASSCODE/CODE column if the admin already had one), populated
 *     with each row's current code.
 * Any codes in the room that don't correspond to a row in the template
 * (typical of an old room whose template pre-dates a later mint) are
 * appended as bare trailing rows so the download always covers every
 * live slot.
 *
 * The original title/banner rows, header case, column order, sheet
 * name and cell formatting all come through unchanged.
 */
export function buildRosterXlsxFromTemplate(
  templateBuffer: Buffer,
  codes: ParticipantCode[],
): Buffer | null {
  const layout = readLayout(templateBuffer);
  if (!layout) return null;
  const { ws, headerRow, nameCol, snCol, metaByHeaderLower, dataStartRow } = layout;

  // Add a PASSCODE column at the right edge if the template didn't
  // already have one. We put it after every meta column so the
  // operator's own layout keeps its shape.
  let passcodeCol = layout.passcodeCol;
  if (passcodeCol == null) {
    passcodeCol = layout.dataColEnd + 1;
    writeCell(ws, headerRow, passcodeCol, "PASSCODE");
    extendRefTo(ws, headerRow, passcodeCol);
  }

  // Index the codes so we can look up by S/N or, when the template
  // doesn't have an S/N column, by row-order.
  const codesBySlot = new Map(codes.map((c) => [c.slot, c]));
  const codesSortedBySlot = [...codes].sort((a, b) => a.slot - b.slot);
  const seenSlots = new Set<number>();

  const dataRowCount = Math.max(0, layout.dataEndRow - dataStartRow + 1);
  for (let i = 0; i < dataRowCount; i++) {
    const r = dataStartRow + i;
    let code: ParticipantCode | undefined;
    if (snCol >= 0) {
      const snCell = ws[XLSX.utils.encode_cell({ r, c: snCol })];
      const rawSn = snCell ? Number(snCell.v) : NaN;
      if (Number.isFinite(rawSn) && rawSn > 0) code = codesBySlot.get(Math.floor(rawSn));
    }
    if (!code) code = codesSortedBySlot[i];
    if (!code) continue;
    seenSlots.add(code.slot);

    writeCell(ws, r, nameCol, code.name);
    for (const [key, col] of Array.from(metaByHeaderLower.entries())) {
      const val = code.meta?.[key] ?? "";
      writeCell(ws, r, col, val);
    }
    writeCell(ws, r, passcodeCol, code.code);
    extendRefTo(ws, r, passcodeCol);
  }

  // Append any codes not represented in the template as trailing bare
  // rows. Typical when append-mode uploads have added slots the
  // template row-count doesn't cover.
  let nextRow = Math.max(layout.dataEndRow, dataStartRow - 1) + 1;
  for (const code of codesSortedBySlot) {
    if (seenSlots.has(code.slot)) continue;
    if (snCol >= 0) writeCell(ws, nextRow, snCol, code.slot);
    writeCell(ws, nextRow, nameCol, code.name);
    for (const [key, col] of Array.from(metaByHeaderLower.entries())) {
      const val = code.meta?.[key] ?? "";
      if (val) writeCell(ws, nextRow, col, val);
    }
    writeCell(ws, nextRow, passcodeCol, code.code);
    extendRefTo(ws, nextRow, passcodeCol);
    nextRow += 1;
  }

  return XLSX.write(layout.wb, { type: "buffer", bookType: "xlsx", cellStyles: true });
}

/**
 * Append-mode upload: fold a fresh xlsx into the room's existing
 * template so the extended roster keeps rendering in the operator's
 * original layout. The new file's data rows are copied in below the
 * template's data range; columns are mapped by lowercased header name
 * so re-ordering or extra columns in the second file line up sensibly.
 * Columns the template doesn't have are dropped — the whole point is
 * that the template's layout is authoritative.
 *
 * Returns the merged buffer, or null when either file couldn't be
 * parsed (in which case the caller should just replace the stored
 * template with the incoming file).
 */
export function mergeRosterFiles(
  templateBuffer: Buffer,
  incomingBuffer: Buffer,
): Buffer | null {
  const layout = readLayout(templateBuffer);
  const incoming = readLayout(incomingBuffer);
  if (!layout || !incoming) return null;

  const dataStartRow = incoming.dataStartRow;
  const dataEndRow = incoming.dataEndRow;
  if (dataEndRow < dataStartRow) return templateBuffer;

  let nextRow = Math.max(layout.dataEndRow, layout.dataStartRow - 1) + 1;
  for (let r = dataStartRow; r <= dataEndRow; r++) {
    const nameCell = incoming.ws[XLSX.utils.encode_cell({ r, c: incoming.nameCol })];
    const nameVal = nameCell ? String(nameCell.v ?? "").trim() : "";
    if (!nameVal) continue;

    writeCell(layout.ws, nextRow, layout.nameCol, nameVal);
    for (const [key, srcCol] of Array.from(incoming.metaByHeaderLower.entries())) {
      const dstCol = layout.metaByHeaderLower.get(key);
      if (dstCol == null) continue;
      const src = incoming.ws[XLSX.utils.encode_cell({ r, c: srcCol })];
      const val = src ? String(src.v ?? "").trim() : "";
      if (val) writeCell(layout.ws, nextRow, dstCol, val);
    }
    extendRefTo(layout.ws, nextRow, layout.dataColEnd);
    nextRow += 1;
  }

  return XLSX.write(layout.wb, { type: "buffer", bookType: "xlsx", cellStyles: true });
}

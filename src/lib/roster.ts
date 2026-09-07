import * as XLSX from "xlsx";
import type { ParticipantCode } from "@/lib/participantCodes";

/**
 * Roster round-trip.
 *
 * Admins arrive with a spreadsheet: S/N, NAME, plus any extra columns
 * they use to keep track of participants (COUNTRY, CONDITION, CONTACT,
 * whatever). We parse it, apply the names to the room's codes, keep the
 * extras as meta, and hand back the same shape with a PASSCODE column
 * appended and the join URL at the top so an operator can copy-paste
 * one row per participant into a mail merge.
 */

export interface RosterRow {
  slot: number;
  name: string;
  meta: Record<string, string>;
}

const NAME_KEYS = ["full name", "fullname", "name", "participant", "child"];
const SN_KEYS = ["s/n", "sn", "s.n.", "s.n", "no", "no.", "num", "#", "id"];

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
 */
export function buildRosterXlsx(
  codes: ParticipantCode[],
  opts: { joinUrl: string; roomName: string },
): Buffer {
  const metaKeys = new Set<string>();
  for (const c of codes) {
    if (c.meta) Object.keys(c.meta).forEach((k) => metaKeys.add(k));
  }
  const metaCols = [...metaKeys];

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

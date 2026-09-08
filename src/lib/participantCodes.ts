import { kv } from "@vercel/kv";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

/**
 * Personal join codes for the participant grid.
 *
 * A code carries a slot, so "Child 17" is named and positioned before anyone
 * arrives. Claiming is a separate NX key rather than a field on the record,
 * because "has this code already got a camera running" has to be atomic — two
 * people pasting the same code must not both go live.
 */

export interface ParticipantCode {
  /** What the participant types, e.g. 4KQ2-17 */
  code: string;
  /** 1-based position on the control-room screen */
  slot: number;
  /** Tile label, e.g. "Child 17" or "EMMANUEL" once a roster is uploaded */
  name: string;
  /** AMS stream id this participant publishes to */
  streamId: string;
  /**
   * Free-form roster columns kept alongside the code so the download
   * round-trip preserves them. Keys are lowercased header names
   * ("country", "condition", "contact"). Old records without this field
   * are handled everywhere as if the meta object were empty.
   */
  meta?: Record<string, string>;
}

/** Codes never outlive the event by much; claims free up on their own. */
const CLAIM_TTL_SECONDS = 12 * 60 * 60;

/** Ambiguous glyphs removed: no O/0, I/1, S/5. */
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";

const codesKey = (room: string) => `neo:video:codes:${room}`;
const claimKey = (room: string, code: string) => `neo:video:claim:${room}:${code}`;
const prefixKey = (room: string) => `neo:video:codeprefix:${room}`;

export const roomMainTrack = (room = SIMULCAST_MAIN) => `${room}-room`;
export const participantStreamId = (room: string, slot: number) =>
  `${room}-p${String(slot).padStart(2, "0")}`;

export function normaliseCode(raw: string): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

/** 4KQ2-17 and 4kq217 are the same code. */
function keyForCode(raw: string): string {
  return normaliseCode(raw);
}

function randomPrefix(): string {
  let out = "";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 4; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function formatCode(prefix: string, slot: number): string {
  return `${prefix}-${String(slot).padStart(2, "0")}`;
}

/**
 * Creates codes for slots 1..count, reusing the room's existing prefix so
 * previously issued invitations keep working when the list is extended.
 */
export async function mintCodes(
  room: string,
  count: number,
): Promise<{ prefix: string; codes: ParticipantCode[] }> {
  const existing = await kv.get<string>(prefixKey(room));
  const prefix = existing ?? randomPrefix();
  if (!existing) await kv.set(prefixKey(room), prefix);

  const codes: ParticipantCode[] = [];
  const record: Record<string, string> = {};

  for (let slot = 1; slot <= count; slot += 1) {
    const code = formatCode(prefix, slot);
    const entry: ParticipantCode = {
      code,
      slot,
      name: `Child ${slot}`,
      streamId: participantStreamId(room, slot),
    };
    codes.push(entry);
    record[keyForCode(code)] = JSON.stringify(entry);
  }

  if (codes.length) await kv.hset(codesKey(room), record);
  return { prefix, codes };
}

export async function listCodes(room: string): Promise<ParticipantCode[]> {
  const all = await kv.hgetall<Record<string, ParticipantCode | string>>(codesKey(room));
  if (!all) return [];
  return Object.values(all)
    .map((v) => (typeof v === "string" ? (JSON.parse(v) as ParticipantCode) : v))
    .sort((a, b) => a.slot - b.slot);
}

/**
 * Apply an uploaded roster: rename existing codes to the roster's names
 * and attach any extra columns as meta. If the roster references slots
 * beyond what's currently minted, the missing codes are minted first so
 * the room grows to fit.
 *
 * Slots not covered by the roster keep their previous name — an admin
 * uploading a partial roster (say, only slots 1..30 of a 50-slot room)
 * shouldn't blank out the last 20 tiles. If they want a smaller room
 * they can delete and recreate.
 */
export async function applyRoster(
  room: string,
  rows: { slot: number; name: string; meta?: Record<string, string> }[],
  opts?: { append?: boolean },
): Promise<{ updated: number; created: number }> {
  const existing = await listCodes(room);
  const bySlot = new Map(existing.map((c) => [c.slot, c]));

  // Append mode: ignore whatever S/N the incoming xlsx says, and place
  // the new rows immediately after the last CUSTOMISED slot. A slot is
  // "customised" when its name has been renamed away from the default
  // "Child N" or it carries roster meta — so uploading the very first
  // xlsx into a fresh room still starts at slot 1 (nothing customised
  // yet), while a second upload lands after the first upload's block.
  const isDefault = (c: ParticipantCode) =>
    c.name === `Child ${c.slot}` && (!c.meta || Object.keys(c.meta).length === 0);
  if (opts?.append) {
    let lastCustom = 0;
    for (const c of existing) if (!isDefault(c)) lastCustom = Math.max(lastCustom, c.slot);
    rows = rows.map((r, i) => ({ ...r, slot: lastCustom + i + 1 }));
  }

  const maxSlot = rows.reduce(
    (m, r) => Math.max(m, r.slot),
    existing.length ? existing[existing.length - 1].slot : 0,
  );
  let created = 0;
  if (maxSlot > existing.length) {
    await mintCodes(room, maxSlot);
    created = maxSlot - existing.length;
    const refreshed = await listCodes(room);
    refreshed.forEach((c) => bySlot.set(c.slot, c));
  }

  const record: Record<string, string> = {};
  let updated = 0;
  for (const r of rows) {
    const cur = bySlot.get(r.slot);
    if (!cur) continue;
    const name = r.name.trim();
    if (!name) continue;
    const next: ParticipantCode = {
      ...cur,
      name,
      meta: r.meta && Object.keys(r.meta).length ? r.meta : cur.meta,
    };
    record[keyForCode(cur.code)] = JSON.stringify(next);
    updated += 1;
  }
  if (Object.keys(record).length) await kv.hset(codesKey(room), record);

  return { updated, created };
}

/**
 * Edit one participant after upload. Admins use this to fix roster
 * typos — a misspelled name, a wrong condition — without re-uploading
 * the whole spreadsheet.
 *
 * `meta` merges: keys with an empty string value are DELETED (so an
 * admin can clear a stale column), other values overwrite. `name`
 * replaces when non-empty; an empty string is treated as "leave alone"
 * because the tile has to show something.
 *
 * Returns the updated record, or null when the slot doesn't exist.
 */
export async function updateParticipant(
  room: string,
  slot: number,
  patch: { name?: string; meta?: Record<string, string> },
): Promise<ParticipantCode | null> {
  const existing = await listCodes(room);
  const cur = existing.find((c) => c.slot === slot);
  if (!cur) return null;

  let name = cur.name;
  if (typeof patch.name === "string") {
    const trimmed = patch.name.trim();
    if (trimmed) name = trimmed;
  }

  let meta = cur.meta;
  if (patch.meta) {
    const next: Record<string, string> = { ...(cur.meta ?? {}) };
    for (const [k, v] of Object.entries(patch.meta)) {
      const key = k.toLowerCase().trim();
      if (!key) continue;
      const val = String(v ?? "").trim();
      if (val) next[key] = val;
      else delete next[key];
    }
    meta = Object.keys(next).length ? next : undefined;
  }

  const nextEntry: ParticipantCode = { ...cur, name, meta };
  await kv.hset(codesKey(room), {
    [keyForCode(cur.code)]: JSON.stringify(nextEntry),
  });
  return nextEntry;
}

export async function lookupCode(room: string, raw: string): Promise<ParticipantCode | null> {
  const key = keyForCode(raw);
  if (!key) return null;
  const v = await kv.hget<ParticipantCode | string>(codesKey(room), key);
  if (!v) return null;
  return typeof v === "string" ? (JSON.parse(v) as ParticipantCode) : v;
}

export type ClaimResult =
  | { ok: true; entry: ParticipantCode; rejoined: boolean }
  | { ok: false; reason: "unknown_code" | "in_use" };

/**
 * Claims a code for one device. The same device may re-claim its own code
 * freely — participants reload, lose wifi and come back, and being locked out
 * of your own slot mid-event is worse than the sharing it would prevent.
 */
export async function claimCode(
  room: string,
  raw: string,
  deviceId: string,
): Promise<ClaimResult> {
  const entry = await lookupCode(room, raw);
  if (!entry) return { ok: false, reason: "unknown_code" };

  const key = claimKey(room, keyForCode(raw));
  const won = await kv.set(key, deviceId, { nx: true, ex: CLAIM_TTL_SECONDS });
  if (won) return { ok: true, entry, rejoined: false };

  const holder = await kv.get<string>(key);
  if (holder && holder === deviceId) {
    await kv.expire(key, CLAIM_TTL_SECONDS);
    return { ok: true, entry, rejoined: true };
  }
  return { ok: false, reason: "in_use" };
}

/** Staff override, and the participant's own "leave" action. */
export async function releaseCode(room: string, raw: string): Promise<void> {
  await kv.del(claimKey(room, keyForCode(raw)));
}

export async function claimedCodes(room: string): Promise<Set<string>> {
  const entries = await listCodes(room);
  if (!entries.length) return new Set();
  const holders = await Promise.all(
    entries.map((e) => kv.get<string>(claimKey(room, keyForCode(e.code)))),
  );
  const out = new Set<string>();
  entries.forEach((e, i) => {
    if (holders[i]) out.add(e.code);
  });
  return out;
}

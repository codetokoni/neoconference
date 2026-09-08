import { kv } from "@vercel/kv";

/**
 * Persists uploaded xlsx bytes for a room's roster.
 *
 * Two overlapping models:
 *
 *  1. **Batches** — one entry per upload event, so an operator who
 *     uploaded three separate spreadsheets can download three files
 *     back, each keeping its own layout (title banners, column order,
 *     header case, sheet name). Overlay of current NAME + meta values
 *     from `participantCodes` on top of that batch's template at
 *     download time, so post-upload edits from RosterEditor still
 *     show up. Every batch carries the slot range it landed in so the
 *     overlay only rewrites cells for its own participants.
 *
 *  2. **Legacy single-file** — the pre-batches version stashed one
 *     merged file per room. Still populated on every upload so the
 *     old `GET /api/video/room/roster` (no `?batch=`) download path
 *     keeps working.
 *
 * Stored as base64 in Vercel KV — @vercel/kv serialises to JSON, and
 * xlsx buffers are almost always well under 200 KB, so the ~33% base64
 * inflation is a non-issue.
 */

const rosterFileKey = (room: string) => `neo:video:rosterfile:${room}`;
const rosterBatchKey = (room: string, id: string) =>
  `neo:video:rosterbatch:${room}:${id}`;
const rosterBatchIndexKey = (room: string) => `neo:video:rosterbatches:${room}`;

export interface RosterBatchMeta {
  id: string;
  filename: string;
  uploadedAt: number;
  slotStart: number;
  slotEnd: number;
  rowCount: number;
}

export async function saveRosterFile(room: string, bytes: Buffer): Promise<void> {
  await kv.set(rosterFileKey(room), bytes.toString("base64"));
}

export async function loadRosterFile(room: string): Promise<Buffer | null> {
  const raw = await kv.get<string>(rosterFileKey(room));
  if (!raw) return null;
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return null;
  }
}

export async function clearRosterFile(room: string): Promise<void> {
  await kv.del(rosterFileKey(room));
}

/**
 * Generate a compact, URL-safe batch id. Timestamp prefix keeps the
 * default sort chronological and avoids id collisions for two uploads
 * inside the same millisecond.
 */
function newBatchId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return Date.now().toString(36) + "-" + rand;
}

/**
 * Save one upload as its own batch entry. The metadata list is kept
 * chronological (oldest first) so the UI can render uploads in the
 * order they landed.
 */
export async function saveRosterBatch(
  room: string,
  bytes: Buffer,
  info: {
    filename: string;
    slotStart: number;
    slotEnd: number;
    rowCount: number;
  },
): Promise<RosterBatchMeta> {
  const id = newBatchId();
  const meta: RosterBatchMeta = {
    id,
    filename: info.filename,
    uploadedAt: Date.now(),
    slotStart: info.slotStart,
    slotEnd: info.slotEnd,
    rowCount: info.rowCount,
  };
  await kv.set(rosterBatchKey(room, id), bytes.toString("base64"));
  const existing = (await kv.get<RosterBatchMeta[]>(rosterBatchIndexKey(room))) ?? [];
  existing.push(meta);
  await kv.set(rosterBatchIndexKey(room), existing);
  return meta;
}

export async function listRosterBatches(room: string): Promise<RosterBatchMeta[]> {
  return (await kv.get<RosterBatchMeta[]>(rosterBatchIndexKey(room))) ?? [];
}

export async function loadRosterBatch(
  room: string,
  id: string,
): Promise<Buffer | null> {
  const raw = await kv.get<string>(rosterBatchKey(room, id));
  if (!raw) return null;
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return null;
  }
}

export async function getRosterBatchMeta(
  room: string,
  id: string,
): Promise<RosterBatchMeta | null> {
  const all = await listRosterBatches(room);
  return all.find((b) => b.id === id) ?? null;
}

/** Remove one batch, from both the index and the storage entry. */
export async function deleteRosterBatch(room: string, id: string): Promise<boolean> {
  const existing = await listRosterBatches(room);
  const next = existing.filter((b) => b.id !== id);
  if (next.length === existing.length) return false;
  await kv.del(rosterBatchKey(room, id));
  await kv.set(rosterBatchIndexKey(room), next);
  return true;
}

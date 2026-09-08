import { kv } from "@vercel/kv";

/**
 * Persists the raw bytes of the last xlsx an admin uploaded for a room,
 * so the download can re-emit the exact layout the admin already knows
 * (title banners, column order, header case, sheet name — everything
 * that `parseRoster` normalises away). We overlay the current NAME +
 * meta values from `participantCodes` on top of that template at
 * download time, so post-upload edits from RosterEditor still show up.
 *
 * Stored as base64 in Vercel KV — @vercel/kv serialises to JSON, and
 * xlsx buffers are almost always well under 200 KB, so the ~33% base64
 * inflation is a non-issue.
 */

const rosterFileKey = (room: string) => `neo:video:rosterfile:${room}`;

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

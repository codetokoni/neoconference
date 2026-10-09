// src/lib/videoBroadcaster.ts
//
// Who viewers of a room watch. One stream per room, decided here on the
// server and sent to every viewer by /api/video/status, so the player never
// guesses from whatever video happens to arrive.
//
// Why: participant cameras (<room>-pNN) publish into the same AMS group
// (<room>-room) as the programme (<room>-video). The player used to put the
// last video track the group sent on the main screen, so a viewer could get
// a participant's camera — another centre's stage, or a black frame from a
// camera that was off — instead of the host. Now the player plays exactly
// this stream id, on its own connection, and nothing else.
//
//   neo:video:broadcaster:<room>   { streamId, label, setBy, at }
//
// Without a record the broadcaster is the room's programme feed
// (<room>-video). An assignment must be a stream of the same room — the
// programme or one of its participant slots — so a typo or another room's
// stream can never be put in front of this room's viewers.

import { kv } from "@/lib/kv";
import { videoChannelForRoom } from "@/lib/simulcast";

export interface BroadcasterRecord {
  streamId: string;
  label: string;
  setBy: string;
  at: number;
}

export interface Broadcaster {
  streamId: string;
  label: string;
  /** "default" = the room's programme feed; "assigned" = set in the control room. */
  source: "default" | "assigned";
}

export const broadcasterKey = (room: string) => `neo:video:broadcaster:${room}`;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A stream this room may put in front of its viewers: its programme, or one of its participant slots. */
export function isRoomBroadcastStream(room: string, streamId: unknown): streamId is string {
  if (typeof streamId !== "string" || !room) return false;
  if (streamId === videoChannelForRoom(room).id) return true;
  return new RegExp(`^${escape(room)}-p\\d{1,4}$`).test(streamId);
}

/** A featured participant (or anything else) shown to this room must belong to it. */
export function belongsToRoom(room: string, streamId: unknown): boolean {
  return typeof streamId === "string" && streamId.startsWith(`${room}-`);
}

export function defaultBroadcaster(room: string): Broadcaster {
  const v = videoChannelForRoom(room);
  return { streamId: v.id, label: "Programme", source: "default" };
}

export async function getBroadcaster(room: string): Promise<Broadcaster> {
  let rec: BroadcasterRecord | null = null;
  try {
    const raw = await kv.get<BroadcasterRecord | string>(broadcasterKey(room));
    rec = typeof raw === "string" ? (JSON.parse(raw) as BroadcasterRecord) : raw;
  } catch {
    rec = null;
  }
  // A stored value that no longer validates (hand-edited, or from before a
  // rename) is ignored rather than shown.
  if (rec && isRoomBroadcastStream(room, rec.streamId)) {
    return { streamId: rec.streamId, label: rec.label || rec.streamId, source: "assigned" };
  }
  return defaultBroadcaster(room);
}

export async function setBroadcaster(room: string, streamId: string, label: string, setBy: string): Promise<Broadcaster> {
  if (!isRoomBroadcastStream(room, streamId)) {
    throw new Error(`${streamId} is not a stream of room ${room}`);
  }
  const rec: BroadcasterRecord = { streamId, label: label.trim().slice(0, 80) || streamId, setBy, at: Date.now() };
  await kv.set(broadcasterKey(room), JSON.stringify(rec));
  return { streamId, label: rec.label, source: "assigned" };
}

export async function clearBroadcaster(room: string): Promise<Broadcaster> {
  await kv.del(broadcasterKey(room));
  return defaultBroadcaster(room);
}

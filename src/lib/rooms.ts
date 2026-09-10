import { kv } from "@vercel/kv";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import { listCodes, mintCodes } from "@/lib/participantCodes";
import { ensureMainTrackWrapper } from "@/lib/amsMainTrack";

/**
 * Registry of video rooms.
 *
 * A "room" is one event's worth of participant slots, codes, layouts,
 * featured pointer, preview pointer, queues — everything downstream is
 * keyed by room slug. This registry exists so a producer can create a
 * second event without editing env vars, and so the /video/rooms list
 * has something to show.
 *
 * The default room from SIMULCAST_MAIN (usually "neoconf") predates this
 * registry: it has codes but never had a registry entry. To avoid it
 * disappearing from the list, listRooms and getRoom both synthesise an
 * entry for it when codes exist but no registry record does.
 */

export interface Room {
  slug: string;
  name: string;
  slotCount: number;
  createdAt: number;
}

const roomsKey = () => "neo:video:rooms";

/** Same shape as queue slugs: lowercase alphanumerics + dashes, 1-32 chars. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function normaliseSlug(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

function parse(val: Room | string | null | undefined, slug: string): Room | null {
  if (!val) return null;
  const r = typeof val === "string" ? (JSON.parse(val) as Room) : val;
  return {
    slug,
    name: r.name,
    slotCount: r.slotCount,
    createdAt: r.createdAt ?? 0,
  };
}

async function synthDefault(): Promise<Room | null> {
  const codes = await listCodes(SIMULCAST_MAIN);
  if (codes.length === 0) return null;
  return {
    slug: SIMULCAST_MAIN,
    name: SIMULCAST_MAIN,
    slotCount: codes.length,
    createdAt: 0,
  };
}

export async function listRooms(): Promise<Room[]> {
  const all = await kv.hgetall<Record<string, Room | string>>(roomsKey());
  const rooms: Room[] = [];
  if (all) {
    for (const [slug, val] of Object.entries(all)) {
      const r = parse(val, slug);
      if (r) rooms.push(r);
    }
  }
  if (!rooms.some((r) => r.slug === SIMULCAST_MAIN)) {
    const def = await synthDefault();
    if (def) rooms.push(def);
  }
  return rooms.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRoom(slug: string): Promise<Room | null> {
  const val = await kv.hget<Room | string>(roomsKey(), slug);
  const r = parse(val, slug);
  if (r) return r;
  if (slug === SIMULCAST_MAIN) return synthDefault();
  return null;
}

/**
 * Provision a new room. Mints participant codes as part of the same call
 * because a room without codes is useless — no one can join.
 */
export async function createRoom(
  slug: string,
  name: string,
  slotCount: number,
): Promise<Room> {
  const room: Room = { slug, name, slotCount, createdAt: Date.now() };
  await kv.hset(roomsKey(), { [slug]: JSON.stringify(room) });
  await mintCodes(slug, slotCount);
  // Pre-create the AMS main-track wrapper so the first vMix/OBS push
  // has a group to subtrack into. Missing this wrapper is what left
  // us with a black dashboard mid-event on 2026-09-10 — the /status
  // route also self-heals if AMS ever GCs it, but doing it up-front
  // means the very first broadcast just works.
  await ensureMainTrackWrapper(slug, name);
  return room;
}

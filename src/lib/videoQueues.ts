import { kv } from "@/lib/kv";

/**
 * Named queues of participants staged for air.
 *
 * A queue is an ordered list of streamIds. The producer stages who is coming
 * up next; the top entry takes one click to go on air. Queues are stored
 * alongside layouts in KV so they survive reloads and stay shared between
 * operators — a queue is not per-operator.
 *
 * Kept as a hash keyed by slug rather than one KV entry per queue, so
 * listing them for the index page is a single HGETALL.
 */

export interface Queue {
  slug: string;
  name: string;
  order: string[];
  /** Add people to the end of the queue as they go live. */
  auto?: boolean;
  /** Everyone who has ever been in this queue. Auto-add skips them, so
   *  someone removed or taken to air is not put straight back. */
  seen?: string[];
  /** When each auto-added entry was added (ms), so a save from a page
   *  that has not seen it yet does not drop it. */
  addedAt?: Record<string, number>;
}

const queuesKey = (room: string) => `neo:video:queues:${room}`;

/** Slug shape: 1-32 chars, lowercase alphanumerics and dashes only. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Slugs that collide with existing paths under /video/room/. A queue
 * with slug "moderate" (or any of these) would be shadowed by the
 * static route of the same name once we expose queues at
 * /video/room/<slug>, so the API refuses them at create time. Keep
 * this in sync with the folder names under src/app/video/room/.
 */
export const RESERVED_QUEUE_SLUGS = new Set([
  "moderate",
  "cameras",
  "names",
  "queue",
  "queues",
  "roster",
]);

export function normaliseSlug(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s) && !RESERVED_QUEUE_SLUGS.has(s);
}

function parse(val: Queue | string | null | undefined, slug: string): Queue | null {
  if (!val) return null;
  const q = typeof val === "string" ? (JSON.parse(val) as Queue) : val;
  return {
    slug,
    name: q.name,
    order: Array.isArray(q.order) ? q.order : [],
    auto: Boolean(q.auto),
    seen: Array.isArray(q.seen) ? q.seen : [],
    addedAt: q.addedAt && typeof q.addedAt === "object" ? q.addedAt : {},
  };
}

export async function listQueues(room: string): Promise<Queue[]> {
  const all = await kv.hgetall<Record<string, Queue | string>>(queuesKey(room));
  if (!all) return [];
  const out: Queue[] = [];
  for (const [slug, val] of Object.entries(all)) {
    const q = parse(val, slug);
    if (q) out.push(q);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getQueue(room: string, slug: string): Promise<Queue | null> {
  const val = await kv.hget<Queue | string>(queuesKey(room), slug);
  return parse(val, slug);
}

export async function createQueue(
  room: string,
  slug: string,
  name: string,
  auto = false,
): Promise<Queue> {
  const q: Queue = { slug, name, order: [], auto, seen: [], addedAt: {} };
  await kv.hset(queuesKey(room), { [slug]: JSON.stringify(q) });
  return q;
}

export async function updateQueue(
  room: string,
  slug: string,
  patch: { name?: string; order?: string[]; auto?: boolean; since?: number },
): Promise<Queue | null> {
  const existing = await getQueue(room, slug);
  if (!existing) return null;
  let order = patch.order ?? existing.order;
  const addedAt = { ...(existing.addedAt ?? {}) };
  if (patch.order && typeof patch.since === "number") {
    // Entries auto-added after the page making this save last loaded the
    // queue are not in its list; keep them rather than drop them.
    const sent = new Set(patch.order);
    const unseen = existing.order.filter((sid) => !sent.has(sid) && (addedAt[sid] ?? 0) > patch.since!);
    order = [...patch.order, ...unseen];
  }
  const seen = Array.from(new Set([...(existing.seen ?? []), ...existing.order, ...order]));
  for (const sid of Object.keys(addedAt)) if (!order.includes(sid)) delete addedAt[sid];
  const next: Queue = {
    slug,
    name: patch.name ?? existing.name,
    order,
    auto: patch.auto ?? existing.auto ?? false,
    seen,
    addedAt,
  };
  await kv.hset(queuesKey(room), { [slug]: JSON.stringify(next) });
  return next;
}

/**
 * Auto-add: put everyone live (given in slot order) who has never been in
 * the queue at its end. Writes only when someone new is added.
 */
export async function addLiveToQueue(room: string, q: Queue, live: string[]): Promise<Queue> {
  if (!q.auto) return q;
  const seen = new Set([...(q.seen ?? []), ...q.order]);
  const fresh = live.filter((sid) => !seen.has(sid));
  if (!fresh.length) return q;
  const now = Date.now();
  const addedAt = { ...(q.addedAt ?? {}) };
  for (const sid of fresh) addedAt[sid] = now;
  const next: Queue = { ...q, order: [...q.order, ...fresh], seen: [...seen, ...fresh], addedAt };
  await kv.hset(queuesKey(room), { [q.slug]: JSON.stringify(next) });
  return next;
}

/** What a page needs: the bookkeeping fields stay on the server. */
export function publicQueue(q: Queue) {
  return { slug: q.slug, name: q.name, order: q.order, auto: Boolean(q.auto) };
}

export async function deleteQueue(room: string, slug: string): Promise<void> {
  await kv.hdel(queuesKey(room), slug);
}

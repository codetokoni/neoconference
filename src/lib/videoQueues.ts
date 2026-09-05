import { kv } from "@vercel/kv";

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
}

const queuesKey = (room: string) => `neo:video:queues:${room}`;

/** Slug shape: 1-32 chars, lowercase alphanumerics and dashes only. */
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

function parse(val: Queue | string | null | undefined, slug: string): Queue | null {
  if (!val) return null;
  const q = typeof val === "string" ? (JSON.parse(val) as Queue) : val;
  return { slug, name: q.name, order: Array.isArray(q.order) ? q.order : [] };
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
): Promise<Queue> {
  const q: Queue = { slug, name, order: [] };
  await kv.hset(queuesKey(room), { [slug]: JSON.stringify(q) });
  return q;
}

export async function updateQueue(
  room: string,
  slug: string,
  patch: { name?: string; order?: string[] },
): Promise<Queue | null> {
  const existing = await getQueue(room, slug);
  if (!existing) return null;
  const next: Queue = {
    slug,
    name: patch.name ?? existing.name,
    order: patch.order ?? existing.order,
  };
  await kv.hset(queuesKey(room), { [slug]: JSON.stringify(next) });
  return next;
}

export async function deleteQueue(room: string, slug: string): Promise<void> {
  await kv.hdel(queuesKey(room), slug);
}

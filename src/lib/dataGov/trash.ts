// src/lib/dataGov/trash.ts
//
// Recoverable deletion. Where the app deletes someone's content — a meeting,
// a group, a recording — what the delete removes is first copied here, so an
// administrator can put it back within the trash period (the "trash"
// retention setting, 30 days by default). To the user the delete looks
// exactly as before: the thing is gone from every list at once.
//
//   neo:trash:items      hash  id -> TrashItem (no content, just what and whose)
//   neo:trash:snap:<id>  string  gzip+base64 JSON: the KV keys as they were
//   R2 trash/<original key>        a deleted recording, moved (not copied)
//
// Restoring writes the keys back, re-adds the index memberships, reclaims
// the slugs and moves R2 objects back — and refuses (conflict) if anything
// it would write is in use again, rather than overwrite it.
// Purging (src/lib/dataGov/purge.ts) deletes the snapshot and the R2 copies.

import { gzipSync, gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { kv } from "@/lib/kv";
import { deleteObject, isR2Configured, listRecordings, renameObject } from "@/lib/r2";
import { DAY_MS, retentionDays } from "@/lib/dataGov/settings";
import { existingKeys, restoreKeys, snapshotKeys, type KeySnapshot } from "@/lib/dataGov/snapshot";

const ITEMS = "neo:trash:items";
const snapKey = (id: string) => `neo:trash:snap:${id}`;
export const TRASH_PREFIX = "trash/";

export type TrashKind = "meeting" | "group" | "recording" | "upload";

/** Set/zset memberships the delete removed; restore adds them back. */
export interface TrashMembership {
  k: string;
  m: string;
  /** zset score; absent = set. */
  score?: number;
}

export interface TrashItem {
  id: string;
  kind: TrashKind;
  label: string;
  ownerId: string | null;
  /** The original record's id (event id, group id, R2 key). */
  ref: string;
  deletedAt: number;
  deletedBy: string;
  keyCount: number;
  r2: { from: string; to: string; size?: number }[];
  adds: TrashMembership[];
  slugs: { slug: string; id: string }[];
  restoredAt?: number;
  restoredBy?: string;
}

export interface TrashInput {
  kind: TrashKind;
  label: string;
  ownerId: string | null;
  ref: string;
  deletedBy: string;
  keys?: string[];
  r2Keys?: string[];
  adds?: TrashMembership[];
  slugs?: { slug: string; id: string }[];
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

export async function trashWindowMs(): Promise<number> {
  return ((await retentionDays("trash")) ?? 30) * DAY_MS;
}

export function expiresAt(item: Pick<TrashItem, "deletedAt">, windowMs: number): number {
  return item.deletedAt + windowMs;
}

/**
 * Copy what is about to be deleted. KV keys are snapshotted (the caller then
 * deletes as before); R2 objects are moved under trash/ here, which is the
 * delete. Never throws for KV snapshot trouble on the caller: a failure is
 * logged and the delete goes ahead unrecoverable, as it was before.
 */
export async function moveToTrash(input: TrashInput, now = Date.now()): Promise<TrashItem> {
  const id = `tr_${now.toString(36)}${randomBytes(4).toString("hex")}`;
  const snap = input.keys?.length ? await snapshotKeys(input.keys) : [];
  const r2: TrashItem["r2"] = [];
  for (const from of input.r2Keys ?? []) {
    const to = TRASH_PREFIX + from;
    await renameObject(from, to);
    r2.push({ from, to });
  }
  const item: TrashItem = {
    id,
    kind: input.kind,
    label: input.label.slice(0, 200),
    ownerId: input.ownerId,
    ref: input.ref,
    deletedAt: now,
    deletedBy: input.deletedBy,
    keyCount: snap.length,
    r2,
    adds: input.adds ?? [],
    slugs: input.slugs ?? [],
  };
  if (snap.length) await kv.set(snapKey(id), gzipSync(Buffer.from(JSON.stringify(snap))).toString("base64"));
  await kv.hset(ITEMS, { [id]: JSON.stringify(item) });
  return item;
}

/** Best-effort wrapper for app routes: a trash failure must not block the user's delete. */
export async function tryMoveToTrash(input: TrashInput | (() => Promise<TrashInput>)): Promise<TrashItem | null> {
  try {
    return await moveToTrash(typeof input === "function" ? await input() : input);
  } catch (err) {
    console.error("[trash] could not keep a copy; deleting without one", err);
    return null;
  }
}

async function readSnap(id: string): Promise<KeySnapshot[]> {
  const raw = await kv.get(snapKey(id));
  if (raw == null) return [];
  return JSON.parse(gunzipSync(Buffer.from(String(raw), "base64")).toString("utf8")) as KeySnapshot[];
}

export async function getTrashItem(id: string): Promise<TrashItem | null> {
  return parse<TrashItem>(await kv.hget(ITEMS, id));
}

export async function listTrash(opts: { kind?: TrashKind; ownerId?: string; includeRestored?: boolean } = {}): Promise<TrashItem[]> {
  const all = ((await kv.hgetall(ITEMS)) ?? {}) as Record<string, unknown>;
  return Object.values(all)
    .map((v) => parse<TrashItem>(v))
    .filter((t): t is TrashItem => !!t)
    .filter((t) => (opts.includeRestored ? true : !t.restoredAt))
    .filter((t) => !opts.kind || t.kind === opts.kind)
    .filter((t) => !opts.ownerId || t.ownerId === opts.ownerId)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

async function r2Exists(key: string): Promise<boolean> {
  return (await listRecordings(key, 5)).some((o) => o.key === key);
}

export type RestoreResult =
  | { ok: true; item: TrashItem; keys: number; objects: number }
  | { ok: false; error: "not_found" | "expired" | "conflict"; detail?: string };

/** What restoring would run into, without writing anything. */
export async function restoreCheck(item: TrashItem, now = Date.now(), windowMs?: number): Promise<RestoreResult | null> {
  if (item.restoredAt) return { ok: false, error: "not_found", detail: "already restored" };
  const win = windowMs ?? (await trashWindowMs());
  if (expiresAt(item, win) <= now) return { ok: false, error: "expired" };
  const snap = await readSnap(item.id);
  const taken = await existingKeys(snap);
  if (taken.length) return { ok: false, error: "conflict", detail: `in use again: ${taken.slice(0, 3).join(", ")}` };
  for (const s of item.slugs) {
    const cur = await kv.get(`neo:slug:${s.slug}`);
    if (cur != null && String(cur) !== s.id) return { ok: false, error: "conflict", detail: `address /${s.slug} is now another meeting's` };
  }
  if (item.r2.length && isR2Configured()) {
    for (const o of item.r2) if (await r2Exists(o.from)) return { ok: false, error: "conflict", detail: `a file is back at ${o.from}` };
  }
  return null;
}

export async function restoreFromTrash(id: string, by: string, now = Date.now()): Promise<RestoreResult> {
  const item = await getTrashItem(id);
  if (!item) return { ok: false, error: "not_found" };
  const blocked = await restoreCheck(item, now);
  if (blocked) return blocked;
  const snap = await readSnap(id);
  const keys = await restoreKeys(snap);
  for (const a of item.adds) {
    if (a.score === undefined) await kv.sadd(a.k, a.m);
    else await kv.zadd(a.k, { score: a.score, member: a.m });
  }
  for (const s of item.slugs) await kv.set(`neo:slug:${s.slug}`, s.id, { nx: true });
  for (const o of item.r2) await renameObject(o.to, o.from);
  const restored: TrashItem = { ...item, restoredAt: now, restoredBy: by };
  await kv.hset(ITEMS, { [id]: JSON.stringify(restored) });
  await kv.del(snapKey(id));
  return { ok: true, item: restored, keys, objects: item.r2.length };
}

/** Remove an item for good: its snapshot, its R2 copies, its record. */
export async function purgeTrashItem(item: TrashItem): Promise<{ objects: number; keys: number }> {
  let objects = 0;
  if (!item.restoredAt) {
    for (const o of item.r2) {
      try {
        await deleteObject(o.to);
        objects++;
      } catch (err) {
        console.error("[trash] purge: R2 delete failed", o.to, err);
      }
    }
  }
  await kv.del(snapKey(item.id));
  await kv.hdel(ITEMS, item.id);
  return { objects, keys: item.restoredAt ? 0 : item.keyCount };
}

/* ------------------------- what the app's deletes keep ------------------------ */

/** The KV a meeting delete removes (eventStore.delete), as a trash input. */
export function meetingTrashInput(ev: { id: string; slug: string; name: string; ownerUserId: string; aliasSlugs?: string[]; groupId?: string }, deletedBy: string): TrashInput {
  return {
    kind: "meeting",
    label: ev.name || ev.slug,
    ownerId: ev.ownerUserId,
    ref: ev.id,
    deletedBy,
    keys: [`neo:event:${ev.id}`, `neo:meeting:${ev.id}:roles`, `neo:event:${ev.id}:invited`],
    adds: [
      { k: `neo:owner:${ev.ownerUserId}`, m: ev.id },
      { k: "neo:events:all", m: ev.id },
    ],
    slugs: [ev.slug, ...(ev.aliasSlugs ?? [])].map((slug) => ({ slug, id: ev.id })),
  };
}

/** Group meetings are also in the group's sorted index: keep the score. */
export async function withGroupIndex(input: TrashInput, ev: { id: string; groupId?: string }): Promise<TrashInput> {
  if (!ev.groupId) return input;
  const score = await kv.zscore(`neo:group:${ev.groupId}:meetings`, ev.id);
  if (score == null) return input;
  return { ...input, adds: [...(input.adds ?? []), { k: `neo:group:${ev.groupId}:meetings`, m: ev.id, score: Number(score) }] };
}

/** The KV a group delete removes (groupStore.deleteGroup + deleteGroupChat). */
export async function groupTrashInput(
  g: { id: string; name: string; creatorId?: string },
  ownerId: string | null,
  memberIds: string[],
  pendingKeys: string[],
  deletedBy: string,
): Promise<TrashInput> {
  return {
    kind: "group",
    label: g.name,
    ownerId,
    ref: g.id,
    deletedBy,
    keys: [
      `neo:group:${g.id}`,
      `neo:group:${g.id}:members`,
      `neo:group:${g.id}:activity`,
      `neo:group:${g.id}:msgs`,
      `neo:group:${g.id}:ver`,
      `neo:group:${g.id}:read`,
      `neo:group:${g.id}:pending`,
    ],
    adds: [
      ...memberIds.map((uid) => ({ k: `neo:user:${uid}:groups`, m: g.id })),
      ...pendingKeys.map((key) => ({ k: `neo:pending-member:${key}`, m: g.id })),
      { k: "neo:groups:all", m: g.id },
    ],
  };
}

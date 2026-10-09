// src/lib/dataGov/util.ts — small helpers shared by export, erase and purge.

import { kv } from "@/lib/kv";
import { deleteObject, listAllObjects, type R2Object } from "@/lib/r2";

/** Every key matching a glob, by SCAN (never KEYS). */
export async function scanKeys(match: string, cap = 50_000): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | number = 0;
  do {
    const [next, keys] = (await kv.scan(cursor, { match, count: 500 })) as [string | number, string[]];
    out.push(...keys);
    cursor = next;
    if (out.length >= cap) break;
  } while (String(cursor) !== "0");
  return [...new Set(out)];
}

export function parseJson<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

export function fromB64Url(s: string): string {
  try {
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** Every object under an R2 prefix (paged). */
export async function listPrefix(prefix: string): Promise<R2Object[]> {
  return (await listAllObjects(prefix)).items;
}

/** Delete everything under a prefix (relisting until empty). Returns objects and bytes removed. */
export async function deletePrefix(prefix: string): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  for (let round = 0; round < 100; round++) {
    const { items } = await listAllObjects(prefix, 1);
    if (!items.length) break;
    for (const o of items) {
      await deleteObject(o.key);
      objects++;
      bytes += o.size || 0;
    }
  }
  return { objects, bytes };
}

/** Rewrite a list in place, keeping its order and remaining TTL. */
export async function rewriteList(key: string, items: unknown[]): Promise<void> {
  const ttl = Number(await kv.pttl(key));
  await kv.del(key);
  if (items.length) await kv.rpush(key, ...items.map((x) => (typeof x === "string" ? x : JSON.stringify(x))));
  if (ttl > 0) await kv.pexpire(key, ttl);
}

/** Overwrite a string value, keeping its remaining TTL. */
export async function rewriteValue(key: string, value: unknown): Promise<void> {
  const ttl = Number(await kv.pttl(key));
  await kv.set(key, typeof value === "string" ? value : JSON.stringify(value), ttl > 0 ? { px: ttl } : undefined);
}

export const DELETED_NAME = "Deleted user";

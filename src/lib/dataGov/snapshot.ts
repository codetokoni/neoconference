// src/lib/dataGov/snapshot.ts
//
// Copy a few KV keys out (type, value, remaining TTL) and write them back.
// The trash uses it to keep what a delete removed, so an administrator can
// restore it. Values go through `kv` (Upstash JSON), which round-trips the
// objects and JSON strings the stores write.

import { kv } from "@/lib/kv";

export type KvType = "string" | "hash" | "list" | "set" | "zset";

export interface KeySnapshot {
  k: string;
  t: KvType;
  v: unknown;
  /** Milliseconds it had left to live, if it had an expiry. */
  x?: number;
}

export async function snapshotKeys(keys: string[]): Promise<KeySnapshot[]> {
  const out: KeySnapshot[] = [];
  for (const k of [...new Set(keys)]) {
    const t = String(await kv.type(k)) as KvType | "none";
    if (t === "none") continue;
    let v: unknown;
    if (t === "string") v = await kv.get(k);
    else if (t === "hash") v = await kv.hgetall(k);
    else if (t === "list") v = await kv.lrange(k, 0, -1);
    else if (t === "set") v = await kv.smembers(k);
    else if (t === "zset") v = await kv.zrange(k, 0, -1, { withScores: true });
    else continue;
    const ttl = Number(await kv.pttl(k));
    out.push({ k, t, v, ...(ttl > 0 ? { x: ttl } : {}) });
  }
  return out;
}

/** Keys of the snapshot that exist now (a restore would overwrite them). */
export async function existingKeys(snap: KeySnapshot[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of snap) if (Number(await kv.exists(s.k)) > 0) out.push(s.k);
  return out;
}

export async function restoreKeys(snap: KeySnapshot[]): Promise<number> {
  let n = 0;
  for (const s of snap) {
    await kv.del(s.k);
    if (s.t === "string") await kv.set(s.k, s.v as string);
    else if (s.t === "hash") {
      const o = (s.v ?? {}) as Record<string, unknown>;
      if (Object.keys(o).length) await kv.hset(s.k, o);
    } else if (s.t === "list") {
      const l = (s.v ?? []) as unknown[];
      // lrange order is head first; rpush keeps it.
      if (l.length) await kv.rpush(s.k, ...l.map((x) => (typeof x === "string" ? x : JSON.stringify(x))));
    } else if (s.t === "set") {
      const m = (s.v ?? []) as unknown[];
      if (m.length) await kv.sadd(s.k, ...(m as [string, ...string[]]));
    } else if (s.t === "zset") {
      const flat = (s.v ?? []) as unknown[];
      for (let i = 0; i + 1 < flat.length; i += 2) await kv.zadd(s.k, { score: Number(flat[i + 1]), member: String(flat[i]) });
    }
    if (s.x && s.x > 0) await kv.pexpire(s.k, s.x);
    n++;
  }
  return n;
}

// src/lib/platform/apiKeys.ts
//
// Developer API keys (nc_live_…), shared by the developer dashboard
// (/api/developers/keys) and the admin's platform-wide view
// (/api/admin/api-keys). Storage, as it always was:
//
//   apikey:<sha256>           ApiKeyRecord  (what /api/v1 authenticates with)
//   apikey:meta:<id>          KeyMeta       (what screens show; masked)
//   apikey:hash:<id>          the sha256, to find the record from the id
//   apikeys:user:<userId>     set of the account's key ids
//   apikeys:all               set of every key id (added here; filled from
//                             the meta keys once, the first time it is read)
//
// The raw key exists only in the response that creates it.

import { randomBytes, randomUUID } from "crypto";
import { kv } from "@/lib/kv";
import { hashKey, type ApiKeyRecord, type ApiPlan } from "@/lib/apiAuth";

const ALL = "apikeys:all";
const BACKFILLED = "apikeys:all:backfilled";

export interface KeyMeta {
  id: string;
  name: string;
  plan: ApiPlan;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  maskedKey: string;
  /** Set on the admin index; older metas do not carry it. */
  ownerUserId?: string;
  revokedAt?: number;
  revokedBy?: string;
  /** The key this one replaced, when made by a rotation. */
  rotatedFrom?: string;
}

export function maskKey(raw: string): string {
  return `nc_live_...${raw.slice(-4)}`;
}

export async function mintApiKey(input: {
  userId: string;
  name: string;
  plan: ApiPlan;
  rotatedFrom?: string;
}): Promise<{ meta: KeyMeta; raw: string }> {
  const id = randomUUID();
  const raw = `nc_live_${randomBytes(24).toString("hex")}`;
  const hash = hashKey(raw);
  const createdAt = Date.now();
  const record: ApiKeyRecord = {
    id,
    ownerUserId: input.userId,
    name: input.name,
    plan: input.plan,
    createdAt,
    lastUsedAt: null,
    revoked: false,
  };
  const meta: KeyMeta = {
    id,
    name: input.name,
    plan: input.plan,
    createdAt,
    lastUsedAt: null,
    revoked: false,
    maskedKey: maskKey(raw),
    ownerUserId: input.userId,
    ...(input.rotatedFrom ? { rotatedFrom: input.rotatedFrom } : {}),
  };
  await kv.set(`apikey:${hash}`, record);
  await kv.set(`apikey:meta:${id}`, meta);
  await kv.set(`apikey:hash:${id}`, hash);
  await kv.sadd(`apikeys:user:${input.userId}`, id);
  await kv.sadd(ALL, id);
  return { meta, raw };
}

/** Revoke by id. Returns the meta as it was before, or null if there is no such key. */
export async function revokeApiKey(id: string, by: string): Promise<KeyMeta | null> {
  const meta = await kv.get<KeyMeta>(`apikey:meta:${id}`);
  if (!meta) return null;
  const before = { ...meta };
  const hash = await kv.get<string>(`apikey:hash:${id}`);
  await kv.set(`apikey:meta:${id}`, { ...meta, revoked: true, revokedAt: Date.now(), revokedBy: by });
  if (hash) {
    const record = await kv.get<ApiKeyRecord>(`apikey:${hash}`);
    if (record) await kv.set(`apikey:${hash}`, { ...record, revoked: true });
  }
  return before;
}

/** The account a key belongs to (older metas do not say; the record does). */
export async function keyOwner(id: string): Promise<string | null> {
  const meta = await kv.get<KeyMeta>(`apikey:meta:${id}`);
  if (meta?.ownerUserId) return meta.ownerUserId;
  const hash = await kv.get<string>(`apikey:hash:${id}`);
  if (!hash) return null;
  return (await kv.get<ApiKeyRecord>(`apikey:${hash}`))?.ownerUserId ?? null;
}

async function allKeyIds(): Promise<string[]> {
  if (!(await kv.get(BACKFILLED))) {
    // Keys made before the index existed: found once by their meta key.
    const metaKeys = ((await kv.keys("apikey:meta:*")) ?? []) as string[];
    const ids = metaKeys.map((k) => k.slice("apikey:meta:".length)).filter(Boolean);
    if (ids.length) await kv.sadd(ALL, ...(ids as [string, ...string[]]));
    await kv.set(BACKFILLED, 1);
  }
  return ((await kv.smembers(ALL)) ?? []) as string[];
}

/** Every key on the platform, masked, newest first, with its owner. */
export async function listAllApiKeys(): Promise<(Omit<KeyMeta, "ownerUserId"> & { ownerUserId: string | null })[]> {
  const ids = await allKeyIds();
  const out: (Omit<KeyMeta, "ownerUserId"> & { ownerUserId: string | null })[] = [];
  for (const id of ids) {
    const meta = await kv.get<KeyMeta>(`apikey:meta:${id}`);
    if (!meta) continue;
    out.push({ ...meta, ownerUserId: meta.ownerUserId ?? (await keyOwner(id)) });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

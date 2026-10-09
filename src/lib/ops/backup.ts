// src/lib/ops/backup.ts
//
// App-level snapshots of the KV store, kept in R2.
//
// Upstash's own backups and point-in-time restore are only available from
// the Upstash console; nothing here replaces them. This is a second line:
// a daily copy the owner can inspect and restore part of from the admin area.
//
// A snapshot is every key (SCAN, never KEYS) except pure caches, rate
// limits, presence and locks, read verbatim (kvRaw: no JSON round trip)
// with its type and remaining TTL, written as gzipped JSON to
// R2 ops-backups/kv/<id>.json.gz with a SHA-256 of the compressed bytes. It
// is read back from R2 and checked once written; "Verify" checks it again.
// Capped at MAX_KEYS keys / MAX_RAW_BYTES uncompressed — a snapshot that
// hit a cap says so and is never offered for restore.
//
// Restore (owner only, step-up, typed confirmation — the route enforces
// those) is by key prefix: a preview lists the keys it would add, change and
// remove; applying it first writes a "pre-restore" snapshot of exactly those
// prefixes, so restoring that one undoes it. The audit trail, two-factor
// secrets, the backup index and job locks are never restored over.
//
//   neo:ops:backups   hash id -> BackupMeta

import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { kv, kvRaw } from "@/lib/kv";
import { deleteObject, getObjectBytes, isR2Configured, putObject } from "@/lib/r2";
import { newId, parseJson, readHash, scanKeys } from "@/lib/ops/util";

export const SNAPSHOT_EXCLUDE = [
  "ratelimit:",
  "cache:",
  "neo:videochat:rl:",
  "neo:video:joinrl:",
  "neo:presence:",
  "neo:video:preview:",
  "neo:meetings:lastSweepAt",
  "neo:ops:job:lock:",
  "neo:ops:health:h:",
  "neo:admin:mfa:pending:",
];

/** Never written by a restore, whatever prefix is chosen. */
export const RESTORE_PROTECTED = ["neo:admin:audit:", "neo:admin:mfa", "neo:ops:backups", "neo:ops:job:"];

export const MAX_KEYS = 100_000;
export const MAX_RAW_BYTES = 64 * 1024 * 1024;
export const KEEP_SNAPSHOTS = 14;
export const KEEP_PRE_RESTORE = 10;

const INDEX = "neo:ops:backups";
const r2KeyFor = (id: string) => `ops-backups/kv/${id}.json.gz`;

export type KvType = "string" | "hash" | "list" | "set" | "zset";

export interface SnapshotEntry {
  k: string;
  t: KvType;
  v: unknown;
  /** Milliseconds left to live when the snapshot was taken. */
  x?: number;
}

interface SnapshotFile {
  format: "neo-kv-snapshot/1";
  id: string;
  createdAt: number;
  prefixes: string[] | null;
  excluded: string[];
  entries: SnapshotEntry[];
}

export type BackupKind = "scheduled" | "manual" | "pre-restore";

export interface BackupMeta {
  id: string;
  kind: BackupKind;
  createdAt: number;
  createdBy: string;
  r2Key: string;
  bytes: number;
  rawBytes: number;
  keyCount: number;
  sha256: string;
  /** Hit MAX_KEYS or MAX_RAW_BYTES: incomplete, not offered for restore. */
  truncated: boolean;
  truncatedReason?: string;
  prefixes: string[] | null;
  verify?: { at: number; ok: boolean; detail: string };
  /** For a pre-restore snapshot: the snapshot whose restore it protects against. */
  restoreOf?: string;
}

const isExcluded = (k: string) => SNAPSHOT_EXCLUDE.some((p) => k.startsWith(p));
export const isProtected = (k: string) => RESTORE_PROTECTED.some((p) => k.startsWith(p));

function globEscape(prefix: string): string {
  return prefix.replace(/[*?[\]\\]/g, "\\$&");
}

/** Read keys verbatim with their type and TTL. Missing keys (expired since the scan) are skipped. */
export async function dumpKeys(keys: string[]): Promise<SnapshotEntry[]> {
  const out: SnapshotEntry[] = [];
  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys.slice(i, i + 200);
    const rows = await Promise.all(
      batch.map(async (k): Promise<SnapshotEntry | null> => {
        const t = String(await kvRaw.type(k)) as KvType | "none";
        let v: unknown;
        if (t === "string") v = await kvRaw.get(k);
        else if (t === "hash") v = await kvRaw.hgetall(k);
        else if (t === "list") v = await kvRaw.lrange(k, 0, -1);
        else if (t === "set") v = await kvRaw.smembers(k);
        else if (t === "zset") v = await kvRaw.zrange(k, 0, -1, { withScores: true });
        else return null;
        if (v == null) return null;
        const ttl = Number(await kvRaw.pttl(k));
        return ttl > 0 ? { k, t, v, x: ttl } : { k, t, v };
      }),
    );
    for (const r of rows) if (r) out.push(r);
  }
  return out;
}

/** Write one entry back: replaces the key entirely, then its TTL. */
async function writeEntry(e: SnapshotEntry, takenAt: number, now: number): Promise<"written" | "expired"> {
  let ttl: number | undefined;
  if (e.x && e.x > 0) {
    ttl = takenAt + e.x - now;
    if (ttl <= 0) {
      await kvRaw.del(e.k);
      return "expired";
    }
  }
  await kvRaw.del(e.k);
  if (e.t === "string") await kvRaw.set(e.k, e.v as string);
  else if (e.t === "hash") {
    const h = e.v as Record<string, unknown>;
    if (Object.keys(h).length) await kvRaw.hset(e.k, h);
  } else if (e.t === "list") {
    const l = e.v as unknown[];
    if (l.length) await kvRaw.rpush(e.k, ...l);
  } else if (e.t === "set") {
    const s = e.v as unknown[];
    if (s.length) await kvRaw.sadd(e.k, s[0], ...s.slice(1));
  } else if (e.t === "zset") {
    const flat = e.v as unknown[];
    const members: { score: number; member: unknown }[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) members.push({ member: flat[i], score: Number(flat[i + 1]) });
    if (members.length) await kvRaw.zadd(e.k, members[0], ...members.slice(1));
  }
  if (ttl) await kvRaw.pexpire(e.k, ttl);
  return "written";
}

async function keysFor(prefixes: string[] | null): Promise<{ keys: string[]; truncated: boolean }> {
  if (!prefixes) {
    const r = await scanKeys("*", MAX_KEYS + 1);
    return { keys: r.keys, truncated: r.truncated || r.keys.length > MAX_KEYS };
  }
  const all = new Set<string>();
  let truncated = false;
  for (const p of prefixes) {
    const r = await scanKeys(globEscape(p) + "*", MAX_KEYS + 1);
    r.keys.forEach((k) => all.add(k));
    truncated ||= r.truncated;
  }
  return { keys: [...all], truncated: truncated || all.size > MAX_KEYS };
}

function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

export async function listBackups(): Promise<BackupMeta[]> {
  return Object.values(await readHash<BackupMeta>(INDEX)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getBackup(id: string): Promise<BackupMeta | null> {
  return parseJson<BackupMeta>(await kv.hget(INDEX, id));
}

async function saveMeta(m: BackupMeta): Promise<void> {
  await kv.hset(INDEX, { [m.id]: JSON.stringify(m) });
}

/** Take a snapshot (all keys, or only `prefixes`), store it in R2, read it back and verify it. */
export async function createSnapshot(opts: { kind: BackupKind; by: string; prefixes?: string[]; restoreOf?: string }): Promise<BackupMeta> {
  if (!isR2Configured()) throw new Error("R2 is not configured; snapshots are stored there");
  const createdAt = Date.now();
  const id = newId(opts.kind === "pre-restore" ? "pre" : "snap");
  const prefixes = opts.prefixes?.length ? opts.prefixes : null;
  const scanned = await keysFor(prefixes);
  let truncatedReason = scanned.truncated ? `more than ${MAX_KEYS.toLocaleString("en")} keys` : undefined;
  const keys = scanned.keys.filter((k) => !isExcluded(k)).sort().slice(0, MAX_KEYS);
  const entries: SnapshotEntry[] = [];
  let rawBytes = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const part = await dumpKeys(keys.slice(i, i + 1000));
    for (const e of part) {
      rawBytes += JSON.stringify(e).length + 1;
      if (rawBytes > MAX_RAW_BYTES) {
        truncatedReason = `more than ${MAX_RAW_BYTES / 1024 / 1024} MB of data`;
        break;
      }
      entries.push(e);
    }
    if (truncatedReason && rawBytes > MAX_RAW_BYTES) break;
  }
  const file: SnapshotFile = { format: "neo-kv-snapshot/1", id, createdAt, prefixes, excluded: SNAPSHOT_EXCLUDE, entries };
  const json = Buffer.from(JSON.stringify(file), "utf8");
  const gz = gzipSync(json);
  const meta: BackupMeta = {
    id,
    kind: opts.kind,
    createdAt,
    createdBy: opts.by,
    r2Key: r2KeyFor(id),
    bytes: gz.byteLength,
    rawBytes: json.byteLength,
    keyCount: entries.length,
    sha256: sha256(gz),
    truncated: !!truncatedReason,
    ...(truncatedReason ? { truncatedReason } : {}),
    prefixes,
    ...(opts.restoreOf ? { restoreOf: opts.restoreOf } : {}),
  };
  await putObject(meta.r2Key, gz, "application/gzip");
  await saveMeta(meta);
  return (await verifySnapshot(id)) ?? meta;
}

async function readSnapshot(meta: BackupMeta): Promise<{ ok: true; file: SnapshotFile } | { ok: false; detail: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await getObjectBytes(meta.r2Key);
  } catch (e) {
    return { ok: false, detail: `could not read from R2: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (bytes.byteLength !== meta.bytes) return { ok: false, detail: `size ${bytes.byteLength} bytes, expected ${meta.bytes}` };
  const sum = sha256(bytes);
  if (sum !== meta.sha256) return { ok: false, detail: `checksum mismatch (${sum.slice(0, 12)}… ≠ ${meta.sha256.slice(0, 12)}…)` };
  let file: SnapshotFile;
  try {
    file = JSON.parse(gunzipSync(bytes).toString("utf8")) as SnapshotFile;
  } catch {
    return { ok: false, detail: "does not decompress or parse" };
  }
  if (file.format !== "neo-kv-snapshot/1" || file.id !== meta.id) return { ok: false, detail: "not this snapshot" };
  if (file.entries.length !== meta.keyCount) return { ok: false, detail: `${file.entries.length} keys, expected ${meta.keyCount}` };
  return { ok: true, file };
}

/** Re-read the snapshot from R2 and check size, checksum, format and key count. */
export async function verifySnapshot(id: string): Promise<BackupMeta | null> {
  const meta = await getBackup(id);
  if (!meta) return null;
  const r = await readSnapshot(meta);
  const next: BackupMeta = {
    ...meta,
    verify: { at: Date.now(), ok: r.ok, detail: r.ok ? `checksum and ${meta.keyCount.toLocaleString("en")} keys match` : r.detail },
  };
  await saveMeta(next);
  return next;
}

/** Keep the newest KEEP_SNAPSHOTS scheduled/manual and KEEP_PRE_RESTORE pre-restore snapshots. */
export async function applyRetention(): Promise<string[]> {
  const all = await listBackups();
  const drop = [
    ...all.filter((b) => b.kind !== "pre-restore").slice(KEEP_SNAPSHOTS),
    ...all.filter((b) => b.kind === "pre-restore").slice(KEEP_PRE_RESTORE),
  ];
  for (const b of drop) {
    try {
      await deleteObject(b.r2Key);
    } catch (e) {
      console.warn("[ops-backup] could not delete", b.r2Key, e instanceof Error ? e.message : e);
    }
    await kv.hdel(INDEX, b.id);
  }
  return drop.map((b) => b.id);
}

export function cleanPrefixes(input: unknown): { ok: true; prefixes: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Choose at least one key prefix." };
  const prefixes = [...new Set(input.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean))];
  if (!prefixes.length) return { ok: false, error: "Choose at least one key prefix." };
  if (prefixes.length > 20) return { ok: false, error: "At most 20 prefixes at a time." };
  if (prefixes.some((p) => p.length < 3)) return { ok: false, error: "A prefix needs at least 3 characters (a whole-store restore is not offered)." };
  if (prefixes.some((p) => isProtected(p))) return { ok: false, error: "That prefix is protected (audit trail, two-factor, backups or job locks)." };
  return { ok: true, prefixes };
}

export interface RestorePreview {
  snapshotId: string;
  prefixes: string[];
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
  protectedSkipped: number;
  counts: { added: number; changed: number; removed: number };
}

const SHOW = 200;
const sameValue = (a: SnapshotEntry, b: SnapshotEntry) => a.t === b.t && JSON.stringify(a.v) === JSON.stringify(b.v);
const inPrefixes = (k: string, prefixes: string[]) => prefixes.some((p) => k.startsWith(p));

async function plan(meta: BackupMeta, prefixes: string[]) {
  if (meta.truncated) throw new RestoreError("snapshot_incomplete", "This snapshot is incomplete (it hit a size cap) and cannot be restored from.");
  const read = await readSnapshot(meta);
  if (!read.ok) throw new RestoreError("snapshot_invalid", `The snapshot failed verification: ${read.detail}`);
  const want = read.file.entries.filter((e) => inPrefixes(e.k, prefixes));
  const protectedSkipped = want.filter((e) => isProtected(e.k)).length;
  const target = new Map(want.filter((e) => !isProtected(e.k) && !isExcluded(e.k)).map((e) => [e.k, e]));
  const cur = await keysFor(prefixes);
  if (cur.truncated) throw new RestoreError("too_many_keys", `Those prefixes cover more than ${MAX_KEYS.toLocaleString("en")} keys.`);
  const curKeys = cur.keys.filter((k) => !isProtected(k) && !isExcluded(k));
  const current = new Map((await dumpKeys(curKeys)).map((e) => [e.k, e]));
  const added: SnapshotEntry[] = [];
  const changed: SnapshotEntry[] = [];
  let unchanged = 0;
  for (const [k, e] of target) {
    const c = current.get(k);
    if (!c) added.push(e);
    else if (!sameValue(c, e)) changed.push(e);
    else unchanged++;
  }
  const removed = [...current.keys()].filter((k) => !target.has(k));
  return { file: read.file, added, changed, removed, unchanged, protectedSkipped };
}

export class RestoreError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function previewRestore(snapshotId: string, prefixes: string[]): Promise<RestorePreview> {
  const meta = await getBackup(snapshotId);
  if (!meta) throw new RestoreError("not_found", "No such snapshot.");
  const p = await plan(meta, prefixes);
  return {
    snapshotId,
    prefixes,
    added: p.added.map((e) => e.k).sort().slice(0, SHOW),
    changed: p.changed.map((e) => e.k).sort().slice(0, SHOW),
    removed: p.removed.sort().slice(0, SHOW),
    unchanged: p.unchanged,
    protectedSkipped: p.protectedSkipped,
    counts: { added: p.added.length, changed: p.changed.length, removed: p.removed.length },
  };
}

export function confirmPhrase(snapshotId: string): string {
  return `RESTORE ${snapshotId}`;
}

export interface RestoreResult {
  snapshotId: string;
  prefixes: string[];
  preRestoreId: string;
  written: number;
  removed: number;
  expired: number;
}

/**
 * Apply a restore. Takes a verified pre-restore snapshot of the same
 * prefixes first and stops if that fails. The caller holds the job lock.
 */
export async function applyRestore(snapshotId: string, prefixes: string[], by: string): Promise<RestoreResult> {
  const meta = await getBackup(snapshotId);
  if (!meta) throw new RestoreError("not_found", "No such snapshot.");
  const p = await plan(meta, prefixes);
  const pre = await createSnapshot({ kind: "pre-restore", by, prefixes, restoreOf: snapshotId });
  if (!pre.verify?.ok || pre.truncated) {
    throw new RestoreError("pre_restore_failed", `Could not take a verified pre-restore snapshot (${pre.verify?.detail ?? pre.truncatedReason ?? "unknown"}); nothing was changed.`);
  }
  const now = Date.now();
  let written = 0;
  let expired = 0;
  for (const e of [...p.added, ...p.changed]) {
    if ((await writeEntry(e, p.file.createdAt, now)) === "written") written++;
    else expired++;
  }
  for (const k of p.removed) await kvRaw.del(k);
  return { snapshotId, prefixes, preRestoreId: pre.id, written, removed: p.removed.length, expired };
}

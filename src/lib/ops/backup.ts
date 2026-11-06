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
// Capped at MAX_KEYS keys / MAX_RAW_BYTES uncompressed / SNAPSHOT_BUDGET_MS
// of reading — a snapshot that hit a cap says so and is never offered for
// restore. Retention always keeps the newest complete one.
//
// The file is one JSON document, written as it is read (a gzip stream, one
// entry per line) so the store never has to fit in one string: the first
// line is the header up to `"entries":[`, then one entry per line (each but
// the last ending in a comma), then `]}`. Verify and restore read it back a
// line at a time. Older single-line files still read.
//
// Restore (owner only, step-up, typed confirmation — the route enforces
// those) is by key prefix: a preview lists the keys it would add, change and
// remove; applying it first writes a "pre-restore" snapshot of exactly those
// prefixes, so restoring that one undoes it. A key that names, or holds, the
// id of an account whose deletion was completed (data governance's
// neo:data:erased) is left exactly as it is now: never written back, never
// removed — a restore cannot bring an erased person back. The audit trail, two-factor
// secrets, the backup index, job locks and data-governance records
// (neo:data:, e.g. erasure tombstones) are never restored over.
//
//   neo:ops:backups   hash id -> BackupMeta

import { createGzip, createGunzip, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { kv, kvRaw } from "@/lib/kv";
import { deleteObject, getObjectBytes, isR2Configured, putObject } from "@/lib/r2";
import { newId, parseJson, readHash, scanKeys } from "@/lib/ops/util";
import { erasedUserIds } from "@/lib/dataGov/requests";

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
// neo:data: holds data-governance records (erasure tombstones): a restore must never un-erase anyone.
export const RESTORE_PROTECTED = ["neo:admin:audit:", "neo:admin:mfa", "neo:ops:backups", "neo:ops:job:", "neo:data:"];

// The store passed the first caps (100,000 keys / 64 MB) on 23 Oct 2026, at
// about 196,000 keys and 170 MB; every snapshot after that was partial.
export const MAX_KEYS = 1_000_000;
export const MAX_RAW_BYTES = 1024 * 1024 * 1024;
/** Reading stops here, well inside the cron's 300 s, so a slow night says why instead of being killed. */
export const SNAPSHOT_BUDGET_MS = 200_000;
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

interface SnapshotHeader {
  format: "neo-kv-snapshot/1";
  id: string;
  createdAt: number;
  prefixes: string[] | null;
  excluded: string[];
}

interface SnapshotFile extends SnapshotHeader {
  entries: SnapshotEntry[];
}

/** Lower limits, for tests. */
export interface SnapshotLimits {
  maxKeys?: number;
  maxRawBytes?: number;
  budgetMs?: number;
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

/** Keys read per round: the client pipelines each round's commands into one request. */
const DUMP_BATCH = 1000;
/** Keys asked for per SCAN step (a hint to the store), for fewer round trips over a big store. */
const SCAN_COUNT = 5000;

/**
 * Read keys verbatim with their type and TTL. Missing keys (expired since
 * the scan) are skipped. Two round trips a batch: every key's type and TTL,
 * then every value. (It was three per 200 keys, and at 196,000 keys a full
 * snapshot no longer fitted in the cron's 300 s.)
 */
export async function dumpKeys(keys: string[]): Promise<SnapshotEntry[]> {
  const out: SnapshotEntry[] = [];
  for (let i = 0; i < keys.length; i += DUMP_BATCH) {
    const batch = keys.slice(i, i + DUMP_BATCH);
    const heads = await Promise.all(
      batch.map(async (k) => {
        const [t, ttl] = await Promise.all([kvRaw.type(k), kvRaw.pttl(k)]);
        return { k, t: String(t) as KvType | "none", ttl: Number(ttl) };
      }),
    );
    const rows = await Promise.all(
      heads.map(async ({ k, t, ttl }): Promise<SnapshotEntry | null> => {
        let v: unknown;
        if (t === "string") v = await kvRaw.get(k);
        else if (t === "hash") v = await kvRaw.hgetall(k);
        else if (t === "list") v = await kvRaw.lrange(k, 0, -1);
        else if (t === "set") v = await kvRaw.smembers(k);
        else if (t === "zset") v = await kvRaw.zrange(k, 0, -1, { withScores: true });
        else return null;
        if (v == null) return null;
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

async function keysFor(prefixes: string[] | null, maxKeys = MAX_KEYS): Promise<{ keys: string[]; truncated: boolean }> {
  if (!prefixes) {
    const r = await scanKeys("*", maxKeys + 1, SCAN_COUNT);
    return { keys: r.keys, truncated: r.truncated || r.keys.length > maxKeys };
  }
  const all = new Set<string>();
  let truncated = false;
  for (const p of prefixes) {
    const r = await scanKeys(globEscape(p) + "*", maxKeys + 1, SCAN_COUNT);
    r.keys.forEach((k) => all.add(k));
    truncated ||= r.truncated;
  }
  return { keys: [...all], truncated: truncated || all.size > maxKeys };
}

/** Gzip text as it is written, keeping the compressed bytes. */
function gzipWriter() {
  const gz = createGzip();
  const chunks: Buffer[] = [];
  gz.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    gz.on("end", resolve);
    gz.on("error", reject);
  });
  let raw = 0;
  return {
    get rawBytes() {
      return raw;
    },
    async write(text: string) {
      raw += Buffer.byteLength(text, "utf8");
      if (!gz.write(text, "utf8")) await new Promise((r) => gz.once("drain", r));
    },
    async end(): Promise<Buffer> {
      gz.end();
      await done;
      return Buffer.concat(chunks);
    },
  };
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

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 * 1024 ? `${bytes / 1024 / 1024 / 1024} GB` : `${bytes / 1024 / 1024} MB`);

/** Take a snapshot (all keys, or only `prefixes`), store it in R2, read it back and verify it. */
export async function createSnapshot(opts: {
  kind: BackupKind;
  by: string;
  prefixes?: string[];
  restoreOf?: string;
  limits?: SnapshotLimits;
}): Promise<BackupMeta> {
  if (!isR2Configured()) throw new Error("R2 is not configured; snapshots are stored there");
  const maxKeys = opts.limits?.maxKeys ?? MAX_KEYS;
  const maxRawBytes = opts.limits?.maxRawBytes ?? MAX_RAW_BYTES;
  const budgetMs = opts.limits?.budgetMs ?? SNAPSHOT_BUDGET_MS;
  const createdAt = Date.now();
  const id = newId(opts.kind === "pre-restore" ? "pre" : "snap");
  const prefixes = opts.prefixes?.length ? opts.prefixes : null;
  const scanned = await keysFor(prefixes, maxKeys);
  let truncatedReason = scanned.truncated ? `more than ${maxKeys.toLocaleString("en")} keys` : undefined;
  const keys = scanned.keys.filter((k) => !isExcluded(k)).sort().slice(0, maxKeys);
  const header: SnapshotHeader = { format: "neo-kv-snapshot/1", id, createdAt, prefixes, excluded: SNAPSHOT_EXCLUDE };
  const out = gzipWriter();
  await out.write(JSON.stringify(header).slice(0, -1) + ',"entries":[');
  let keyCount = 0;
  let stop = false;
  for (let i = 0; i < keys.length && !stop; i += 1000) {
    if (Date.now() - createdAt > budgetMs) {
      truncatedReason = `took longer than ${Math.round(budgetMs / 1000)} s to read`;
      break;
    }
    for (const e of await dumpKeys(keys.slice(i, i + 1000))) {
      const line = (keyCount ? ",\n" : "\n") + JSON.stringify(e);
      if (out.rawBytes + Buffer.byteLength(line, "utf8") > maxRawBytes) {
        truncatedReason = `more than ${sizeText(maxRawBytes)} of data`;
        stop = true;
        break;
      }
      await out.write(line);
      keyCount++;
    }
  }
  await out.write("\n]}");
  const rawBytes = out.rawBytes;
  const gz = await out.end();
  const meta: BackupMeta = {
    id,
    kind: opts.kind,
    createdAt,
    createdBy: opts.by,
    r2Key: r2KeyFor(id),
    bytes: gz.byteLength,
    rawBytes,
    keyCount,
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

/**
 * Decompress and parse a snapshot a line at a time, keeping only the
 * entries `keep` wants (all of them when it is left out). `count` is every
 * entry in the file. Throws when it does not decompress or parse.
 */
async function parseSnapshot(
  bytes: Uint8Array,
  keep?: (k: string) => boolean,
): Promise<{ header: SnapshotHeader; entries: SnapshotEntry[]; count: number }> {
  const lines = createInterface({ input: Readable.from([Buffer.from(bytes)]).pipe(createGunzip()), crlfDelay: Infinity });
  let header: SnapshotHeader | null = null;
  const entries: SnapshotEntry[] = [];
  let count = 0;
  let closed = false;
  for await (const line of lines) {
    if (!header) {
      if (!line.endsWith('"entries":[')) {
        // A file written before 7 Nov 2026: the whole document on one line.
        lines.close();
        const file = JSON.parse(gunzipSync(bytes).toString("utf8")) as SnapshotFile;
        const { entries: all, ...head } = file;
        return { header: head, entries: keep ? all.filter((e) => keep(e.k)) : all, count: all.length };
      }
      header = JSON.parse(line + "]}") as SnapshotHeader;
      continue;
    }
    if (line === "]}") {
      closed = true;
      continue;
    }
    if (closed) throw new Error("text after the end");
    const e = JSON.parse(line.endsWith(",") ? line.slice(0, -1) : line) as SnapshotEntry;
    count++;
    if (!keep || keep(e.k)) entries.push(e);
  }
  if (!header || !closed) throw new Error("ends early");
  return { header, entries, count };
}

async function readSnapshot(
  meta: BackupMeta,
  keep?: (k: string) => boolean,
): Promise<{ ok: true; file: SnapshotFile } | { ok: false; detail: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await getObjectBytes(meta.r2Key);
  } catch (e) {
    return { ok: false, detail: `could not read from R2: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (bytes.byteLength !== meta.bytes) return { ok: false, detail: `size ${bytes.byteLength} bytes, expected ${meta.bytes}` };
  const sum = sha256(bytes);
  if (sum !== meta.sha256) return { ok: false, detail: `checksum mismatch (${sum.slice(0, 12)}… ≠ ${meta.sha256.slice(0, 12)}…)` };
  let parsed: Awaited<ReturnType<typeof parseSnapshot>>;
  try {
    parsed = await parseSnapshot(bytes, keep);
  } catch {
    return { ok: false, detail: "does not decompress or parse" };
  }
  const { header, entries, count } = parsed;
  if (header.format !== "neo-kv-snapshot/1" || header.id !== meta.id) return { ok: false, detail: "not this snapshot" };
  if (count !== meta.keyCount) return { ok: false, detail: `${count} keys, expected ${meta.keyCount}` };
  return { ok: true, file: { ...header, entries } };
}

/** Re-read the snapshot from R2 and check size, checksum, format and key count. */
export async function verifySnapshot(id: string): Promise<BackupMeta | null> {
  const meta = await getBackup(id);
  if (!meta) return null;
  // Verify reads every line but keeps none of the entries.
  const r = await readSnapshot(meta, () => false);
  const next: BackupMeta = {
    ...meta,
    verify: { at: Date.now(), ok: r.ok, detail: r.ok ? `checksum and ${meta.keyCount.toLocaleString("en")} keys match` : r.detail },
  };
  await saveMeta(next);
  return next;
}

/**
 * Remove one snapshot: its R2 object, then its index entry. For data
 * governance's age-based retention (the count cap is applyRetention below).
 * False when there is no such snapshot.
 */
export async function deleteBackup(id: string): Promise<boolean> {
  const meta = await getBackup(id);
  if (!meta) return false;
  await deleteObject(meta.r2Key);
  await kv.hdel(INDEX, id);
  return true;
}

/** A snapshot a restore can use: complete and verified. */
export const isRestorable = (b: BackupMeta) => !b.truncated && !!b.verify?.ok;

/**
 * Keep the newest KEEP_SNAPSHOTS scheduled/manual and KEEP_PRE_RESTORE
 * pre-restore snapshots, and always the newest complete one: when the
 * store outgrew the caps in October 2026, fourteen partial nights pushed the
 * last complete snapshot out and left nothing to restore from.
 */
export async function applyRetention(): Promise<string[]> {
  const all = await listBackups();
  const lastGood = all.find((b) => b.kind !== "pre-restore" && isRestorable(b));
  const drop = [
    ...all.filter((b) => b.kind !== "pre-restore").slice(KEEP_SNAPSHOTS),
    ...all.filter((b) => b.kind === "pre-restore").slice(KEEP_PRE_RESTORE),
  ].filter((b) => b !== lastGood);
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
  if (prefixes.some((p) => isProtected(p))) return { ok: false, error: "That prefix is protected (audit trail, two-factor, backups, job locks or data-governance records)." };
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
  /** Keys left alone because they belong to an erased account. */
  erasedSkipped: string[];
  counts: { added: number; changed: number; removed: number; erasedSkipped: number };
}

const SHOW = 200;
const sameValue = (a: SnapshotEntry, b: SnapshotEntry) => a.t === b.t && JSON.stringify(a.v) === JSON.stringify(b.v);
const inPrefixes = (k: string, prefixes: string[]) => prefixes.some((p) => k.startsWith(p));

async function plan(meta: BackupMeta, prefixes: string[]) {
  if (meta.truncated) throw new RestoreError("snapshot_incomplete", "This snapshot is incomplete (it hit a size cap) and cannot be restored from.");
  const read = await readSnapshot(meta, (k) => inPrefixes(k, prefixes));
  if (!read.ok) throw new RestoreError("snapshot_invalid", `The snapshot failed verification: ${read.detail}`);
  const want = read.file.entries;
  const protectedSkipped = want.filter((e) => isProtected(e.k)).length;
  const erased = await erasedUserIds();
  const mentionsErased = (e: SnapshotEntry) => erased.some((id) => id && (e.k.includes(id) || JSON.stringify(e.v).includes(id)));
  const erasedKeys = new Set(want.filter((e) => !isProtected(e.k) && !isExcluded(e.k) && mentionsErased(e)).map((e) => e.k));
  const target = new Map(want.filter((e) => !isProtected(e.k) && !isExcluded(e.k) && !erasedKeys.has(e.k)).map((e) => [e.k, e]));
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
  // A current key the snapshot holds for an erased account stays as it is now.
  const removed = [...current.keys()].filter((k) => !target.has(k) && !erasedKeys.has(k));
  return { file: read.file, added, changed, removed, unchanged, protectedSkipped, erasedSkipped: [...erasedKeys].sort() };
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
    erasedSkipped: p.erasedSkipped.slice(0, SHOW),
    counts: { added: p.added.length, changed: p.changed.length, removed: p.removed.length, erasedSkipped: p.erasedSkipped.length },
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

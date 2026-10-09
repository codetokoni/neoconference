// src/lib/content/files.ts
//
// The file index: one record per stored object the app creates, written at
// each upload and egress point and filled in for older objects by the
// backfill (./backfill.ts).
//
//   neo:content:files            hash  fileId -> FileRecord JSON
//   neo:content:egress:<id>      string  egressId -> fileId (3 days; egress_ended finds its file)
//   neo:content:hidden-events    hash  slug -> HiddenEvent JSON (a meeting unpublished by a moderator)
//
// fileId is derived from where the bytes are, so the same object always has
// the same record however the index learns about it.
//
// Writing the index must never break what it describes: every hook below
// is awaited by its caller (Vercel drops unawaited work) and swallows its
// own failures. A file the hook missed is found by the next backfill.

import { createHash } from "node:crypto";
import { kv } from "@/lib/kv";
import {
  classifyKey,
  guessContentType,
  type ContentType,
  type FileRecord,
  type FileState,
  type ProcessingStatus,
  type Storage,
  type Visibility,
} from "@/lib/content/model";

const FILES = "neo:content:files";
const HIDDEN_EVENTS = "neo:content:hidden-events";
const egressKey = (egressId: string) => `neo:content:egress:${egressId}`;
const EGRESS_TTL_S = 3 * 24 * 60 * 60;
/** Where phase 11 keeps retention settings ({ values: { trash: days } }). */
const RETENTION = "neo:data:retention";
export const TRASH_DAYS_DEFAULT = 30;

export function fileId(storage: Storage, key: string): string {
  return "f_" + createHash("sha256").update(`${storage}:${key}`).digest("base64url").slice(0, 20);
}

export function md5Checksum(body: Uint8Array): string {
  return "md5:" + createHash("md5").update(body).digest("hex");
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

/* --------------------------------- records -------------------------------- */

export async function getFile(id: string): Promise<FileRecord | null> {
  if (!/^f_[A-Za-z0-9_-]{20}$/.test(String(id || ""))) return null;
  return parse<FileRecord>(await kv.hget(FILES, id));
}

export async function getFileByKey(storage: Storage, key: string): Promise<FileRecord | null> {
  return parse<FileRecord>(await kv.hget(FILES, fileId(storage, key)));
}

export async function allFiles(): Promise<FileRecord[]> {
  const all = ((await kv.hgetall(FILES)) ?? {}) as Record<string, unknown>;
  return Object.values(all)
    .map((v) => parse<FileRecord>(v))
    .filter((r): r is FileRecord => !!r);
}

export async function putFiles(records: FileRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    if (chunk.length) await kv.hset(FILES, Object.fromEntries(chunk.map((r) => [r.id, JSON.stringify(r)])));
  }
}

export async function putFile(r: FileRecord): Promise<void> {
  await kv.hset(FILES, { [r.id]: JSON.stringify(r) });
}

export async function forgetFile(id: string): Promise<void> {
  await kv.hdel(FILES, id);
}

/** A record for an object the index has not seen, from what its key says. */
export function recordFromKey(
  storage: Storage,
  key: string,
  extra: Partial<FileRecord> & { source: FileRecord["source"] },
  now = Date.now(),
): FileRecord {
  const facts = classifyKey(key);
  return {
    id: fileId(storage, key),
    storage,
    key,
    type: facts.type,
    ownerId: facts.ownerId,
    ...(facts.eventSlug ? { eventSlug: facts.eventSlug } : {}),
    ...(facts.groupId ? { groupId: facts.groupId } : {}),
    ...(facts.ticketId ? { ticketId: facts.ticketId } : {}),
    ...(facts.name ? { name: facts.name } : {}),
    ...(facts.startedAt ? { startedAt: facts.startedAt } : {}),
    size: 0,
    contentType: guessContentType(key),
    createdAt: now,
    updatedAt: now,
    status: "ready",
    statusAt: now,
    visibility: "private",
    state: "active",
    ...extra,
  };
}

async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[content-index] ${what} failed`, err);
  }
}

/* ---------------------------------- hooks --------------------------------- */

export interface UploadFacts {
  /** Where the bytes went; R2 unless said. */
  storage?: Storage;
  key: string;
  type: ContentType;
  ownerId: string;
  groupId?: string;
  eventSlug?: string;
  ticketId?: string;
  name: string;
  size: number;
  contentType: string;
  body?: Uint8Array;
}

/** At an upload point, after the bytes are stored. */
export async function indexUpload(f: UploadFacts): Promise<void> {
  await safely("indexUpload", async () => {
    const now = Date.now();
    const { body, storage = "r2", ...facts } = f;
    await putFile(
      recordFromKey(storage, f.key, {
        ...facts,
        source: "upload",
        status: "ready",
        statusAt: now,
        ...(body ? { checksum: md5Checksum(body) } : {}),
      }),
    );
  });
}

/** At an upload point, when storing the bytes failed: a "failed upload" for the Problems view. */
export async function indexUploadFailed(f: UploadFacts & { detail: string }): Promise<void> {
  await safely("indexUploadFailed", async () => {
    const now = Date.now();
    const { detail, body: _body, storage = "r2", ...facts } = f;
    await putFile(
      recordFromKey(storage, f.key, { ...facts, source: "upload", status: "failed", statusAt: now, statusDetail: detail.slice(0, 300) }),
    );
  });
}

/** When a recording starts (src/lib/roomRecording.ts): its files are on their way. */
export async function indexEgressStarted(input: {
  room: string;
  recorderUserId: string;
  egressId: string;
  filepath: string;
  audioEgressId: string | null;
  audioFilepath: string | null;
}): Promise<void> {
  await safely("indexEgressStarted", async () => {
    const now = Date.now();
    const files: { egressId: string; key: string }[] = [{ egressId: input.egressId, key: input.filepath }];
    if (input.audioEgressId && input.audioFilepath) files.push({ egressId: input.audioEgressId, key: input.audioFilepath });
    for (const f of files) {
      const r = recordFromKey("r2", f.key, {
        source: "egress",
        ownerId: input.recorderUserId,
        eventSlug: input.room,
        egressId: f.egressId,
        status: "processing",
        statusAt: now,
        startedAt: now,
      });
      await putFile(r);
      await kv.set(egressKey(f.egressId), r.id, { ex: EGRESS_TTL_S });
    }
  });
}

type EgressInfoish = {
  egressId?: string;
  roomName?: string;
  status?: number | string;
  error?: string;
  endedAt?: unknown;
  file?: { filename?: string; size?: unknown };
  fileResults?: Array<{ filename?: string; size?: unknown }>;
};

/** LiveKit's EgressStatus: 3 COMPLETE, 4 FAILED, 5 ABORTED, 6 LIMIT_REACHED (numbers, or names in JSON). */
export function egressStatus(status: unknown, error?: string): { status: ProcessingStatus; detail?: string } {
  const s = String(status ?? "").toUpperCase();
  if (s === "3" || s.endsWith("COMPLETE")) return { status: "ready" };
  if (s === "4" || s.endsWith("FAILED")) return { status: "failed", detail: error || "Recording failed" };
  if (s === "5" || s.endsWith("ABORTED")) return { status: "failed", detail: error || "Recording was aborted" };
  if (s === "6" || s.endsWith("LIMIT_REACHED")) return { status: "ready", detail: error || "Recording stopped at LiveKit's limit" };
  return error ? { status: "failed", detail: error } : { status: "ready" };
}

function num(v: unknown): number | null {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** At egress_ended (the LiveKit webhook): the recording finished writing, or failed. */
export async function indexEgressEnded(info: EgressInfoish | undefined): Promise<void> {
  if (!info?.egressId) return;
  await safely("indexEgressEnded", async () => {
    const now = Date.now();
    const filename = info.fileResults?.[0]?.filename || info.file?.filename || "";
    const mapped = parse<string>(await kv.get(egressKey(info.egressId!)));
    let rec = mapped ? await getFile(mapped) : null;
    if (!rec && filename) rec = await getFileByKey("r2", filename);
    if (!rec && !filename) return; // a livestream, or a failure before any file was named
    if (!rec) rec = recordFromKey("r2", filename, { source: "egress", egressId: info.egressId });
    const outcome = egressStatus(info.status, info.error);
    const size = num(info.fileResults?.[0]?.size) ?? num(info.file?.size);
    const endedNs = num(info.endedAt);
    await putFile({
      ...rec,
      status: outcome.status,
      statusAt: now,
      ...(outcome.detail ? { statusDetail: outcome.detail.slice(0, 300) } : { statusDetail: undefined }),
      ...(size != null ? { size } : {}),
      endedAt: endedNs ? Math.round(endedNs / 1e6) : now,
      updatedAt: now,
    });
  });
}

type TranscribeJobish = {
  id: string;
  recordingKey: string;
  eventSlug?: string;
  status: "queued" | "running" | "done" | "error";
  text?: string;
  error?: string;
  createdAt?: string;
};

/** Whenever a transcription job is stored (src/lib/transcribeStore.ts): its transcript's record. */
export async function indexTranscriptJob(job: TranscribeJobish): Promise<void> {
  if (!job?.recordingKey) return;
  await safely("indexTranscriptJob", async () => {
    const now = Date.now();
    const key = `transcript:${job.recordingKey}`;
    const prev = await getFileByKey("kv", key);
    const facts = classifyKey(job.recordingKey);
    const status: ProcessingStatus =
      job.status === "done" ? "ready" : job.status === "error" ? "failed" : job.status === "running" ? "processing" : "pending";
    const created = Date.parse(job.createdAt || "");
    const base: FileRecord = prev ?? {
      id: fileId("kv", key),
      storage: "kv",
      key,
      type: "transcript",
      ownerId: facts.ownerId,
      ...(job.eventSlug || facts.eventSlug ? { eventSlug: job.eventSlug || facts.eventSlug } : {}),
      recordingKey: job.recordingKey,
      name: `Transcript of ${facts.name ?? job.recordingKey}`,
      size: 0,
      contentType: "text/plain",
      createdAt: Number.isFinite(created) ? created : now,
      updatedAt: now,
      status,
      statusAt: now,
      visibility: "private",
      state: "active",
      source: "transcribe",
    };
    await putFile({
      ...base,
      status,
      statusAt: prev?.status === status ? prev.statusAt : now,
      statusDetail: job.status === "error" ? (job.error || "Transcription failed").slice(0, 300) : undefined,
      size: job.text ? Buffer.byteLength(job.text, "utf8") : base.size,
      updatedAt: now,
    });
  });
}

/** A share link was made for this object: anyone with the link can download it now. */
export async function markShared(key: string): Promise<void> {
  await safely("markShared", async () => {
    const rec = (await getFileByKey("r2", key)) ?? recordFromKey("r2", key, { source: "backfill" });
    if (rec.visibility === "private") await putFile({ ...rec, visibility: "shared", updatedAt: Date.now() });
  });
}

/** The owner deleted the object (the recordings page): nothing left to index. */
export async function indexDeleted(key: string): Promise<void> {
  await safely("indexDeleted", () => forgetFile(fileId("r2", key)));
}

/** The owner renamed the object: same record, new key (and so a new id). */
export async function indexRenamed(oldKey: string, newKey: string): Promise<void> {
  await safely("indexRenamed", async () => {
    const prev = await getFileByKey("r2", oldKey);
    if (!prev) return;
    const facts = classifyKey(newKey);
    await putFile({ ...prev, id: fileId("r2", newKey), key: newKey, name: facts.name ?? prev.name, updatedAt: Date.now() });
    await forgetFile(prev.id);
  });
}

/* ------------------------- what public pages may serve -------------------- */

/** Keys that are hidden by a moderator or in the trash, so public pages leave them out. */
export async function blockedKeys(keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const recs = await Promise.all(keys.map((k) => getFileByKey("r2", k)));
    recs.forEach((r, i) => {
      if (r && r.state !== "active") out.add(keys[i]);
    });
  } catch (err) {
    // Serving what was served before beats serving nothing on a KV blip.
    console.warn("[content-index] blockedKeys failed", err);
  }
  return out;
}

/** Keys in the trash (the owner's own lists leave those out; hidden ones they still see). */
export async function trashedKeys(keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const recs = await Promise.all(keys.map((k) => getFileByKey("r2", k)));
    recs.forEach((r, i) => {
      if (r?.state === "trashed") out.add(keys[i]);
    });
  } catch (err) {
    console.warn("[content-index] trashedKeys failed", err);
  }
  return out;
}

export interface HiddenEvent {
  at: number;
  byId: string;
  byEmail: string;
  reason: string;
  caseId?: string;
}

export async function getHiddenEvent(slug: string): Promise<HiddenEvent | null> {
  if (!slug) return null;
  try {
    return parse<HiddenEvent>(await kv.hget(HIDDEN_EVENTS, slug));
  } catch (err) {
    console.warn("[content-index] getHiddenEvent failed", err);
    return null;
  }
}

export async function hiddenEventSlugs(): Promise<Set<string>> {
  try {
    return new Set(Object.keys(((await kv.hgetall(HIDDEN_EVENTS)) ?? {}) as Record<string, unknown>));
  } catch (err) {
    console.warn("[content-index] hiddenEventSlugs failed", err);
    return new Set();
  }
}

export async function setHiddenEvent(slug: string, h: HiddenEvent | null): Promise<void> {
  if (h) await kv.hset(HIDDEN_EVENTS, { [slug]: JSON.stringify(h) });
  else await kv.hdel(HIDDEN_EVENTS, slug);
}

/* ------------------------------ moderation state -------------------------- */

/** Restore window for the trash: phase 11's "trash" retention, else 30 days. */
export async function trashWindowDays(): Promise<number> {
  try {
    const v = parse<{ values?: { trash?: unknown } }>(await kv.get(RETENTION));
    const d = v?.values?.trash;
    if (typeof d === "number" && d > 0) return d;
  } catch {
    // fall through to the default
  }
  return TRASH_DAYS_DEFAULT;
}

export function setState(rec: FileRecord, state: FileState, by: { userId: string }, reason: string, now = Date.now()): FileRecord {
  return { ...rec, state, stateAt: now, stateById: by.userId, stateReason: reason.slice(0, 300), updatedAt: now };
}

/** What a public link can reach, given the meeting it belongs to. */
export function effectiveVisibility(
  rec: Pick<FileRecord, "type" | "visibility">,
  ev: { visibility?: string; replayEnabled?: boolean } | null | undefined,
): Visibility {
  if ((rec.type === "recording" || rec.type === "recording_audio") && ev && ev.replayEnabled !== false) {
    // The replay page shows a meeting's recordings to anyone with the link.
    return ev.visibility === "public" ? "public" : rec.visibility === "public" ? "public" : "shared";
  }
  return rec.visibility;
}

/** The trashed records an administrator can still restore, with when each window closes. */
export async function listTrashedFiles(now = Date.now()): Promise<{ record: FileRecord; restoreUntil: number; expired: boolean }[]> {
  const days = await trashWindowDays();
  return (await allFiles())
    .filter((r) => r.state === "trashed")
    .map((record) => {
      const restoreUntil = (record.stateAt ?? record.updatedAt) + days * 24 * 60 * 60 * 1000;
      return { record, restoreUntil, expired: restoreUntil <= now };
    })
    .sort((a, b) => (b.record.stateAt ?? 0) - (a.record.stateAt ?? 0));
}


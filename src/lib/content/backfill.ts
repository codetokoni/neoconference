// src/lib/content/backfill.ts
//
// Fill the file index from the bucket: list R2 a page at a time (read-only:
// nothing is moved, changed or deleted), add a record for each object the
// index has not seen and refresh size and checksum for those it has. Each
// run stops at a cap — objects or time — and leaves a cursor, so the next
// run carries on where this one stopped; a pass that reaches the end of the
// listing is "complete", and only then can the Problems view say a file is
// missing from storage (the index has it, the complete pass did not see it).
//
//   neo:content:backfill   JSON BackfillState

import { kv } from "@/lib/kv";
import { listObjectsPage, type R2Object } from "@/lib/r2";
import { getGroup } from "@/lib/groupStore";
import { checksumFromEtag, type FileRecord } from "@/lib/content/model";
import { allFiles, fileId, putFiles, recordFromKey } from "@/lib/content/files";

const STATE = "neo:content:backfill";

export interface PassTotals {
  objects: number;
  bytes: number;
  added: number;
  updated: number;
}

export interface BackfillState {
  /** The listing cursor for the pass under way; null = the next run starts a new pass. */
  token: string | null;
  passStartedAt: number | null;
  pass: PassTotals;
  runs: number;
  lastRunAt: number | null;
  lastCompletePass: (PassTotals & { startedAt: number; finishedAt: number }) | null;
}

const EMPTY: BackfillState = {
  token: null,
  passStartedAt: null,
  pass: { objects: 0, bytes: 0, added: 0, updated: 0 },
  runs: 0,
  lastRunAt: null,
  lastCompletePass: null,
};

export async function backfillState(): Promise<BackfillState> {
  const raw = await kv.get(STATE);
  if (raw == null) return { ...EMPTY };
  const v = typeof raw === "object" ? (raw as BackfillState) : (JSON.parse(String(raw)) as BackfillState);
  return { ...EMPTY, ...v };
}

export const BACKFILL_LIMITS = { maxObjects: 50_000, maxMs: 50_000, defaultObjects: 5_000, defaultMs: 20_000 };

export interface BackfillRun {
  scanned: number;
  added: number;
  updated: number;
  bytes: number;
  pages: number;
  stoppedBy: "complete" | "max_objects" | "max_ms";
  state: BackfillState;
}

type Lister = typeof listObjectsPage;

/**
 * One run. `restart` drops the cursor and starts a new pass. The lister is
 * the R2 listing; a test passes its own.
 */
export async function runBackfill(opts: { maxObjects?: number; maxMs?: number; restart?: boolean; lister?: Lister } = {}): Promise<BackfillRun> {
  const started = Date.now();
  const maxObjects = Math.min(Math.max(Math.round(opts.maxObjects ?? BACKFILL_LIMITS.defaultObjects), 1), BACKFILL_LIMITS.maxObjects);
  const maxMs = Math.min(Math.max(Math.round(opts.maxMs ?? BACKFILL_LIMITS.defaultMs), 100), BACKFILL_LIMITS.maxMs);
  const lister = opts.lister ?? listObjectsPage;

  const state = await backfillState();
  if (opts.restart || state.token == null) {
    state.token = null;
    state.passStartedAt = started;
    state.pass = { objects: 0, bytes: 0, added: 0, updated: 0 };
  }
  const passStartedAt = state.passStartedAt ?? started;

  const known = new Map((await allFiles()).map((r) => [r.id, r] as const));
  const groupOwners = new Map<string, string | null>();
  const groupOwner = async (gid: string) => {
    if (!groupOwners.has(gid)) {
      try {
        groupOwners.set(gid, (await getGroup(gid))?.creatorId ?? null);
      } catch {
        groupOwners.set(gid, null);
      }
    }
    return groupOwners.get(gid) ?? null;
  };

  const run = { scanned: 0, added: 0, updated: 0, bytes: 0, pages: 0 };
  let stoppedBy: BackfillRun["stoppedBy"] = "max_objects";
  let token = state.token;
  for (;;) {
    if (run.scanned >= maxObjects) {
      stoppedBy = "max_objects";
      break;
    }
    if (Date.now() - started >= maxMs) {
      stoppedBy = "max_ms";
      break;
    }
    const page = await lister({ token, maxKeys: Math.min(1000, maxObjects - run.scanned) });
    run.pages++;
    const seen: FileRecord[] = [];
    let added = 0;
    let updated = 0;
    for (const o of page.objects) {
      if (!o.key) continue;
      run.scanned++;
      run.bytes += o.size;
      const rec = await toRecord(o, known.get(fileId("r2", o.key)) ?? null, passStartedAt, groupOwner);
      // Every record seen is written: r2SeenAt is how a complete pass proves a file is still there.
      seen.push(rec.record);
      if (rec.kind === "added") added++;
      if (rec.kind === "updated") updated++;
      known.set(rec.record.id, rec.record);
    }
    await putFiles(seen);
    run.added += added;
    run.updated += updated;
    token = page.next;
    // Save the cursor after every page: a run cut short resumes from here.
    state.token = token;
    state.pass = {
      objects: state.pass.objects + page.objects.length,
      bytes: state.pass.bytes + page.objects.reduce((s, o) => s + o.size, 0),
      added: state.pass.added + added,
      updated: state.pass.updated + updated,
    };
    if (!token) {
      stoppedBy = "complete";
      break;
    }
    await kv.set(STATE, JSON.stringify(state));
  }
  if (stoppedBy === "complete") {
    state.lastCompletePass = { ...state.pass, startedAt: passStartedAt, finishedAt: Date.now() };
    state.token = null;
    state.passStartedAt = null;
  }
  state.runs++;
  state.lastRunAt = Date.now();
  await kv.set(STATE, JSON.stringify(state));
  return { ...run, stoppedBy, state };
}

async function toRecord(
  o: R2Object,
  prev: FileRecord | null,
  seenAt: number,
  groupOwner: (gid: string) => Promise<string | null>,
): Promise<{ kind: "added" | "updated" | "same"; record: FileRecord }> {
  const checksum = checksumFromEtag(o.etag);
  if (prev) {
    const next: FileRecord = {
      ...prev,
      size: o.size,
      ...(checksum ? { checksum } : {}),
      r2SeenAt: seenAt,
    };
    // A file the index thought was still on its way is there: say so.
    if ((prev.status === "pending" || prev.status === "processing") && o.size > 0 && prev.type !== "recording" && prev.type !== "recording_audio") {
      next.status = "ready";
      next.statusAt = Date.now();
    }
    const changedFacts = prev.size !== next.size || prev.checksum !== next.checksum || prev.status !== next.status;
    return { kind: changedFacts ? "updated" : "same", record: changedFacts ? { ...next, updatedAt: Date.now() } : next };
  }
  const created = o.lastModified ? Date.parse(o.lastModified) : NaN;
  const at = Number.isFinite(created) ? created : Date.now();
  const rec = recordFromKey("r2", o.key, { source: "backfill" }, at);
  if (rec.type === "group_upload" && rec.groupId) rec.ownerId = await groupOwner(rec.groupId);
  return {
    kind: "added",
    record: {
      ...rec,
      size: o.size,
      ...(checksum ? { checksum } : {}),
      status: o.size > 0 ? "ready" : "failed",
      ...(o.size > 0 ? {} : { statusDetail: "Empty object in storage" }),
      r2SeenAt: seenAt,
    },
  };
}

// src/lib/content/problems.ts
//
// What is wrong in the file index, worked out from the records alone (no
// storage calls), so the Problems view is one KV read:
//
//   failed     an upload, recording or transcript that failed
//   stuck      pending/processing for longer than its type ever takes
//   missing    indexed and ready, but the last complete backfill pass did not see it in R2
//   orphan     in R2 with no owner the app can name (or the owner's account is gone)
//   duplicate  the same bytes twice (size + checksum), or two recordings of one
//              meeting made at the same time (overlapping times)
//
// Each problem lists the safe actions it allows. None deletes anything:
// "trash" is the recoverable trash, restorable within the trash window.

import { STUCK_MINUTES, overlaps, type FileRecord, type ProblemKind } from "@/lib/content/model";

export type ProblemAction = "retry" | "relink" | "trash" | "ignore" | "forget";

export interface Problem {
  kind: ProblemKind;
  /** Stable, so the UI can key it and an ignore sticks. */
  id: string;
  fileIds: string[];
  detail: string;
  actions: ProblemAction[];
  at: number;
}

export interface ProblemContext {
  now: number;
  /** When the last complete backfill pass began; null = no complete pass yet. */
  lastPassStartedAt: number | null;
  /** Owners whose accounts no longer exist. */
  goneOwners?: Set<string>;
  /** Override STUCK_MINUTES for every type. */
  stuckMinutes?: number;
}

const ignored = (r: FileRecord, k: ProblemKind) => !!r.ignored?.includes(k);

export function detectProblems(records: FileRecord[], ctx: ProblemContext): Problem[] {
  const out: Problem[] = [];
  const live = records.filter((r) => r.state !== "trashed");

  for (const r of live) {
    if (r.status === "failed" && !ignored(r, "failed")) {
      const hasBytes = r.storage === "r2" && r.size > 0;
      out.push({
        kind: "failed",
        id: `failed:${r.id}`,
        fileIds: [r.id],
        detail: r.statusDetail || "Failed",
        actions: [...(r.type === "transcript" ? (["retry"] as const) : []), ...(hasBytes ? (["trash"] as const) : []), "ignore", ...(hasBytes ? [] : (["forget"] as const))],
        at: r.statusAt,
      });
    }
    if ((r.status === "pending" || r.status === "processing") && !ignored(r, "stuck")) {
      const limit = (ctx.stuckMinutes ?? STUCK_MINUTES[r.type]) * 60_000;
      if (ctx.now - r.statusAt > limit) {
        out.push({
          kind: "stuck",
          id: `stuck:${r.id}`,
          fileIds: [r.id],
          detail: `${r.status === "pending" ? "Pending" : "Processing"} for ${Math.round((ctx.now - r.statusAt) / 60_000)} minutes`,
          actions: [r.type === "transcript" ? "retry" : "relink", "ignore"],
          at: r.statusAt,
        });
      }
    }
    if (
      r.storage === "r2" &&
      r.status === "ready" &&
      ctx.lastPassStartedAt != null &&
      r.createdAt < ctx.lastPassStartedAt &&
      (r.r2SeenAt ?? 0) < ctx.lastPassStartedAt &&
      !ignored(r, "missing")
    ) {
      out.push({
        kind: "missing",
        id: `missing:${r.id}`,
        fileIds: [r.id],
        detail: "In the index, but the last complete scan of storage did not find it",
        actions: ["relink", "forget", "ignore"],
        at: r.updatedAt,
      });
    }
    if (r.storage === "r2" && !ignored(r, "orphan")) {
      const gone = r.ownerId && ctx.goneOwners?.has(r.ownerId);
      // A group or support file without an uploader still belongs somewhere.
      const unowned = !r.ownerId && !r.groupId && !r.ticketId;
      if (gone || unowned) {
        out.push({
          kind: "orphan",
          id: `orphan:${r.id}`,
          fileIds: [r.id],
          detail: gone ? "The owner's account no longer exists" : "No owner: the storage path names no account",
          actions: ["relink", "trash", "ignore"],
          at: r.createdAt,
        });
      }
    }
  }

  // Same bytes: same size and checksum.
  const byChecksum = new Map<string, FileRecord[]>();
  for (const r of live) {
    if (!r.checksum || r.size <= 0 || r.storage !== "r2") continue;
    const k = `${r.size}|${r.checksum}`;
    byChecksum.set(k, [...(byChecksum.get(k) ?? []), r]);
  }
  const grouped = new Set<string>();
  for (const [k, rs] of byChecksum) {
    const open = rs.filter((r) => !ignored(r, "duplicate"));
    if (rs.length < 2 || open.length === 0) continue;
    rs.forEach((r) => grouped.add(r.id));
    out.push({
      kind: "duplicate",
      id: `duplicate:sum:${k}`,
      fileIds: rs.map((r) => r.id),
      detail: `${rs.length} copies of the same file (same size and checksum)`,
      actions: ["trash", "ignore"],
      at: Math.max(...rs.map((r) => r.createdAt)),
    });
  }

  // Same meeting, recorded at the same time (two hosts pressed Record).
  const byMeeting = new Map<string, FileRecord[]>();
  for (const r of live) {
    if (r.type !== "recording" || !r.eventSlug || !r.startedAt) continue;
    byMeeting.set(r.eventSlug, [...(byMeeting.get(r.eventSlug) ?? []), r]);
  }
  for (const [slug, rs] of byMeeting) {
    const sorted = [...rs].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const seen = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      if (seen.has(sorted[i].id)) continue;
      const cluster = [sorted[i]];
      for (let j = i + 1; j < sorted.length; j++) {
        if (cluster.some((c) => overlaps(c, sorted[j]))) cluster.push(sorted[j]);
      }
      if (cluster.length < 2) continue;
      cluster.forEach((c) => seen.add(c.id));
      if (cluster.every((c) => grouped.has(c.id))) continue; // already reported as identical copies
      if (cluster.every((c) => ignored(c, "duplicate"))) continue;
      out.push({
        kind: "duplicate",
        id: `duplicate:meeting:${slug}:${cluster[0].id}`,
        fileIds: cluster.map((c) => c.id),
        detail: `${cluster.length} recordings of ${slug} made at overlapping times`,
        actions: ["trash", "ignore"],
        at: Math.max(...cluster.map((c) => c.createdAt)),
      });
    }
  }

  return out.sort((a, b) => b.at - a.at);
}

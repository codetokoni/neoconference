// src/lib/content/actions.ts
//
// The changes an administrator makes to a file — hide, unhide, trash,
// restore — shared by the file view and the moderation queue so both do
// exactly the same thing and audit it the same way. Before/after records
// the state, status, owner and visibility; never the file's contents.
//
// Trash is phase 11's recoverable deletion (src/lib/dataGov/trash.ts): the
// object moves under trash/ in R2, leaves every list and public page, and
// can be restored until the "trash" retention window closes; the retention
// purge removes it after that. Hide only changes the index: the file stays
// where it is and its owner still sees it.

import { recordAdminAction } from "@/lib/admin/audit";
import { actorOf, type AdminContext } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import type { NextResponse } from "next/server";
import type { FileRecord, FileState } from "@/lib/content/model";
import { putFile, setState, trashWindowDays } from "@/lib/content/files";
import { moveToTrash, restoreFromTrash } from "@/lib/dataGov/trash";

export type StateAction = "hide" | "unhide" | "trash" | "restore";

export function auditView(r: FileRecord) {
  return { state: r.state, status: r.status, ownerId: r.ownerId, visibility: r.visibility, ...(r.trashId ? { trashId: r.trashId } : {}) };
}

/** Give a restored file its place back in the index: the state it had before the trash. */
export function restoredRecord(rec: FileRecord, by: { userId: string }, reason: string): FileRecord {
  const back: FileState = rec.trashedFrom === "hidden" ? "hidden" : "active";
  return { ...setState(rec, back, by, reason), trashedFrom: undefined, trashId: undefined };
}

/** What restoreFromTrash's refusals mean to an administrator. */
export async function restoreRefusal(error: "not_found" | "expired" | "conflict", detail?: string): Promise<NextResponse> {
  if (error === "expired") {
    const days = await trashWindowDays();
    return fail("restore_window_passed", `The ${days}-day restore window for this file has passed. The retention purge removes it.`, 410);
  }
  if (error === "conflict") return fail("restore_conflict", `It can't go back: ${detail ?? "something is in its place"}.`, 409);
  return fail("not_in_trash", "This file is not in the trash any more.", 404);
}

/**
 * Apply one state change. Returns the new record, or the refusal to send.
 * `caseId` ties a change made from the moderation queue to its case.
 */
export async function changeFileState(
  ctx: AdminContext,
  req: Request,
  rec: FileRecord,
  action: StateAction,
  reason: string,
  caseId?: string,
): Promise<{ record: FileRecord; unchanged?: boolean } | { response: NextResponse }> {
  const now = Date.now();
  let next: FileRecord;
  if (action === "hide") {
    if (rec.state === "hidden") return { record: rec, unchanged: true };
    if (rec.state === "trashed") return { response: fail("in_trash", "This file is in the trash. Restore it first.", 409) };
    next = setState(rec, "hidden", ctx, reason, now);
  } else if (action === "unhide") {
    if (rec.state !== "hidden") return { record: rec, unchanged: true };
    next = setState(rec, "active", ctx, reason, now);
  } else if (action === "trash") {
    if (rec.state === "trashed") return { record: rec, unchanged: true };
    if (rec.storage !== "r2") {
      return { response: fail("cannot_trash", "Only files kept in storage go to the trash. Transcripts and rosters stay with what they belong to.", 400) };
    }
    let trashId: string;
    try {
      const item = await moveToTrash({
        kind: rec.type === "recording" || rec.type === "recording_audio" ? "recording" : "upload",
        label: rec.name || rec.key,
        ownerId: rec.ownerId,
        ref: rec.key,
        deletedBy: ctx.userId,
        r2Keys: [rec.key],
      });
      trashId = item.id;
    } catch (err) {
      return { response: fail("trash_failed", `Could not move it to the trash: ${(err as Error)?.message ?? "storage error"}. Nothing was changed.`, 502) };
    }
    next = { ...setState(rec, "trashed", ctx, reason, now), trashId, trashedFrom: rec.state };
  } else {
    if (rec.state !== "trashed") return { record: rec, unchanged: true };
    if (!rec.trashId) return { response: fail("not_in_trash", "This file has no trash entry to restore from.", 404) };
    const r = await restoreFromTrash(rec.trashId, ctx.userId, now);
    if (!r.ok) return { response: await restoreRefusal(r.error, r.detail) };
    next = restoredRecord(rec, ctx, reason);
  }
  await putFile(next);
  await recordAdminAction(actorOf(ctx), req, {
    action: `content.file.${action}`,
    targetType: "file",
    targetId: rec.id,
    targetLabel: rec.name || rec.key,
    before: auditView(rec),
    after: auditView(next),
    note: [reason, caseId ? `case ${caseId}` : ""].filter(Boolean).join(" — ") || undefined,
  });
  return { record: next };
}

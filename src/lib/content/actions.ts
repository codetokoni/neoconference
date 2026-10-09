// src/lib/content/actions.ts
//
// The changes an administrator makes to a file — hide, unhide, trash,
// restore — shared by the file view and the moderation queue so both do
// exactly the same thing and audit it the same way. Before/after records
// the state, status, owner and visibility; never the file's contents.
//
// "Trash" moves nothing in storage: the record says trashed, public pages
// and the owner's lists stop showing it, and an administrator can restore
// it within the trash window (phase 11's "trash" retention, 30 days by
// default). Removing the bytes after that is the retention purge's job.

import { recordAdminAction } from "@/lib/admin/audit";
import { actorOf, type AdminContext } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import type { NextResponse } from "next/server";
import type { FileRecord, FileState } from "@/lib/content/model";
import { putFile, setState, trashWindowDays } from "@/lib/content/files";

export type StateAction = "hide" | "unhide" | "trash" | "restore";

export function auditView(r: FileRecord) {
  return { state: r.state, status: r.status, ownerId: r.ownerId, visibility: r.visibility };
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
  let next: FileRecord | null = null;
  if (action === "hide") {
    if (rec.state === "hidden") return { record: rec, unchanged: true };
    if (rec.state === "trashed") return { response: fail("in_trash", "This file is in the trash. Restore it first.", 409) };
    next = setState(rec, "hidden", ctx, reason, now);
  } else if (action === "unhide") {
    if (rec.state !== "hidden") return { record: rec, unchanged: true };
    next = setState(rec, "active", ctx, reason, now);
  } else if (action === "trash") {
    if (rec.state === "trashed") return { record: rec, unchanged: true };
    next = { ...setState(rec, "trashed", ctx, reason, now), trashedFrom: rec.state };
  } else {
    if (rec.state !== "trashed") return { record: rec, unchanged: true };
    const days = await trashWindowDays();
    const until = (rec.stateAt ?? rec.updatedAt) + days * 24 * 60 * 60 * 1000;
    if (until <= now) {
      return {
        response: fail("restore_window_passed", `The ${days}-day restore window for this file has passed. The retention purge may already have removed it.`, 410),
      };
    }
    const back: FileState = rec.trashedFrom === "hidden" ? "hidden" : "active";
    next = { ...setState(rec, back, ctx, reason, now), trashedFrom: undefined };
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

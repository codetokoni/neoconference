// /api/admin/content/files/[id]/action — content:moderate
//
// POST { action, reason?, ownerId?, problem? }
//   hide | unhide     unpublish from public pages (replay, share links) / undo
//   trash | restore   recoverable deletion (a fresh code to trash) / undo within the window
//   relink            check storage again and, with ownerId, give the file its owner
//   retry             run a failed or stuck transcription again
//   ignore | unignore stop / start reporting this file under one problem kind
//   forget            drop an index entry whose bytes are gone (a fresh code)
// Every action is audited with the state before and after.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { checksumFromEtag, isProblemKind, type FileRecord } from "@/lib/content/model";
import { forgetFile, getFile, putFile } from "@/lib/content/files";
import { auditView, changeFileState } from "@/lib/content/actions";
import { headObject } from "@/lib/r2";
import { isTranscribeConfigured, submitTranscribeJob } from "@/lib/transcribe";
import { publicOrigin } from "@/lib/publicOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

const ACTIONS = ["hide", "unhide", "trash", "restore", "relink", "retry", "ignore", "unignore", "forget"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: Request, { params }: Params) {
  const body = await readJson<{ action?: unknown; reason?: unknown; ownerId?: unknown; problem?: unknown }>(req);
  const action = ACTIONS.find((a) => a === body?.action) as Action | undefined;
  // Trashing and forgetting take a fresh code; the rest the permission alone.
  const g = await requireAdmin(req, "content:moderate", { stepUp: action === "trash" || action === "forget" });
  if (!g.ok) return g.response;
  if (!action) return fail("bad_action", "Unknown action.");
  const rec = await getFile(params.id);
  if (!rec) return fail("not_found", "No such file in the index.", 404);
  const reason = str(body?.reason, 300);

  if (action === "hide" || action === "unhide" || action === "trash" || action === "restore") {
    if ((action === "hide" || action === "trash") && !reason) return fail("reason_required", "Say why (it goes in the audit log).");
    const r = await changeFileState(g.ctx, req, rec, action, reason);
    if ("response" in r) return r.response;
    return NextResponse.json({ ok: true, file: r.record, unchanged: !!r.unchanged });
  }

  const audit = (after: FileRecord, note?: string) =>
    recordAdminAction(actorOf(g.ctx), req, {
      action: `content.file.${action}`,
      targetType: "file",
      targetId: rec.id,
      targetLabel: rec.name || rec.key,
      before: auditView(rec),
      after: auditView(after),
      note: note || reason || undefined,
    });

  if (action === "relink") {
    let next: FileRecord = { ...rec, updatedAt: Date.now() };
    const ownerId = str(body?.ownerId, 64);
    if (ownerId) {
      try {
        const client = await clerkClient();
        await client.users.getUser(ownerId);
      } catch {
        return fail("no_such_user", "There is no account with that id.", 400);
      }
      next.ownerId = ownerId;
    }
    let found: Awaited<ReturnType<typeof headObject>> = null;
    if (rec.storage === "r2") {
      found = await headObject(rec.key);
      const now = Date.now();
      if (found) {
        const checksum = checksumFromEtag(found.etag);
        next = { ...next, size: found.size, ...(checksum ? { checksum } : {}), r2SeenAt: now };
        if (rec.status !== "ready" && found.size > 0) next = { ...next, status: "ready", statusAt: now, statusDetail: undefined };
      } else {
        next = { ...next, status: "failed", statusAt: now, statusDetail: "Not found in storage" };
      }
    } else if (!ownerId) {
      return fail("nothing_to_check", "This file is not in R2; give it an owner, or retry it.", 400);
    }
    await putFile(next);
    await audit(next, [reason, rec.storage === "r2" ? (found ? "found in storage" : "not in storage") : ""].filter(Boolean).join(" — "));
    return NextResponse.json({ ok: true, file: next, inStorage: rec.storage === "r2" ? !!found : null });
  }

  if (action === "retry") {
    if (rec.type !== "transcript" || !rec.recordingKey) {
      return fail("cannot_retry", "Only transcriptions can be run again. A failed recording can't be re-made after the meeting.", 400);
    }
    if (!isTranscribeConfigured()) {
      return fail("transcription_not_configured", "Transcription is not set up on this deployment (TRANSCRIBE_PROVIDER and its key).", 503);
    }
    const job = await submitTranscribeJob({ recordingKey: rec.recordingKey, eventSlug: rec.eventSlug, callbackUrlBase: publicOrigin(req) });
    const after = (await getFile(rec.id)) ?? rec;
    await audit(after, `transcription job ${job.id}: ${job.status}`);
    return NextResponse.json({ ok: true, file: after, job: { id: job.id, status: job.status } });
  }

  if (action === "ignore" || action === "unignore") {
    if (!isProblemKind(body?.problem)) return fail("bad_problem", "Say which problem to ignore.");
    const set = new Set(rec.ignored ?? []);
    if (action === "ignore") set.add(body.problem);
    else set.delete(body.problem);
    const next: FileRecord = { ...rec, ignored: [...set], updatedAt: Date.now() };
    await putFile(next);
    await audit(next, `${body.problem}${reason ? ` — ${reason}` : ""}`);
    return NextResponse.json({ ok: true, file: next });
  }

  // forget: only an entry whose bytes are already gone.
  if (rec.storage === "r2" && (await headObject(rec.key))) {
    return fail("still_in_storage", "The file is still in storage. Move it to the trash instead.", 409);
  }
  if (rec.storage !== "r2") return fail("cannot_forget", "Only entries for files missing from R2 can be removed from the index.", 400);
  await forgetFile(rec.id);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "content.file.forget",
    targetType: "file",
    targetId: rec.id,
    targetLabel: rec.name || rec.key,
    before: { ...auditView(rec), key: rec.key, size: rec.size },
    after: null,
    note: reason || "Not in storage",
  });
  return NextResponse.json({ ok: true, forgotten: rec.id });
}

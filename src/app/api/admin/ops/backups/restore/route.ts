// /api/admin/ops/backups/restore — owner only.
//
// POST { snapshotId, prefixes[], mode: "preview" }
//   what restoring those key prefixes from that snapshot would add, change
//   and remove. Changes nothing.
// POST { snapshotId, prefixes[], mode: "apply", confirm: "RESTORE <snapshotId>" }
//   takes a verified pre-restore snapshot of the same prefixes, then writes.
//   Restoring the pre-restore snapshot (its id is in the answer) undoes it.
//
// The platform owner only (a verified PLATFORM_OWNER_EMAILS address — no
// administrator role reaches this), with a fresh authenticator code, under
// the "ops-restore" job lock. Every call is audited, refusals included.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { RestoreError, applyRestore, cleanPrefixes, confirmPhrase, previewRestore, type RestoreResult } from "@/lib/ops/backup";
import { runJob } from "@/lib/ops/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const g = await requireAdmin(req, "ops:write", { stepUp: true });
  if (!g.ok) return g.response;
  const actor = actorOf(g.ctx);
  const b = await readJson<Record<string, unknown>>(req);
  const snapshotId = str(b?.snapshotId, 80);
  const mode = b?.mode === "apply" ? "apply" : "preview";
  const audit = (outcome: "ok" | "denied" | "failed", after: Record<string, unknown>) =>
    recordAdminAction(actor, req, { action: `ops.restore.${mode}`, targetType: "backup", targetId: snapshotId || undefined, outcome, after });

  if (!g.ctx.isOwner) {
    await audit("denied", { reason: "owner_only" });
    return fail("owner_only", "Only the platform owner can restore from a snapshot.", 403);
  }
  if (!snapshotId) return fail("snapshot_required", "Choose a snapshot.");
  const p = cleanPrefixes(b?.prefixes);
  if (!p.ok) return fail("bad_prefixes", p.error);
  const prefixes = p.prefixes;

  try {
    if (mode === "preview") {
      const preview = await previewRestore(snapshotId, prefixes);
      await audit("ok", { prefixes, counts: preview.counts });
      return NextResponse.json({ ok: true, preview, confirmPhrase: confirmPhrase(snapshotId) });
    }
    if (str(b?.confirm, 120) !== confirmPhrase(snapshotId)) {
      await audit("denied", { reason: "confirmation_mismatch", prefixes });
      return fail("confirmation_mismatch", `Type ${confirmPhrase(snapshotId)} to confirm.`);
    }
    let result: RestoreResult | null = null;
    const r = await runJob(
      "ops-restore",
      async () => {
        result = await applyRestore(snapshotId, prefixes, g.ctx.email);
        return { ok: true, summary: `restored ${prefixes.join(", ")} from ${snapshotId}: ${result.written} written, ${result.removed} removed; undo with ${result.preRestoreId}` };
      },
      { trigger: "manual", actor: g.ctx.email },
    );
    if (r.status === "locked") {
      await audit("denied", { reason: "already_running", prefixes });
      return fail("already_running", "A restore is already running.", 409);
    }
    if (r.error !== undefined) throw r.error;
    const done = result as RestoreResult | null;
    await audit("ok", { prefixes, ...(done ?? {}), runId: r.run.id });
    return NextResponse.json({ ok: true, result: done, undo: done ? { snapshotId: done.preRestoreId, prefixes, confirmPhrase: confirmPhrase(done.preRestoreId) } : null });
  } catch (e) {
    const code = e instanceof RestoreError ? e.code : "restore_failed";
    const message = e instanceof Error ? e.message : String(e);
    await audit("failed", { prefixes, error: code, message });
    return fail(code, message, e instanceof RestoreError && e.code === "not_found" ? 404 : 409);
  }
}

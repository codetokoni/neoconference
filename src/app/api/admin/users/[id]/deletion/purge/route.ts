// POST /api/admin/users/[id]/deletion/purge — "Delete now" on the account
// page. users:delete and data:delete (sensitive: a fresh code), and
// { confirm: "delete" } typed by the administrator.
//
// Only for an account whose deletion was requested and whose grace period is
// over. Completion is the Data page's (src/lib/dataGov/actions.ts
// completeDeletion): every place in the data map is deleted or anonymised,
// R2 files removed, the Clerk user deleted last, and a deletion certificate
// (counts, no personal data) written to the audit trail. Refused for the
// owner, under legal hold, and while the account owns a group others are in
// (hand it over first, on the Groups page).

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { fail, readJson } from "@/lib/admin/http";
import { getDeletion, loadTargetUser, targetGuard } from "@/lib/admin/users";
import { erasureBlockers } from "@/lib/dataGov/erase";
import { DATA_JOBS, asJob, completeDeletion } from "@/lib/dataGov/actions";
import { jobLockHolder } from "@/lib/ops/jobs";
import type { DeletionRequest } from "@/lib/dataGov/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, ["users:delete", "data:delete"]);
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;

  const deletion = (await getDeletion(t.user.id)) as DeletionRequest | null;
  if (!deletion) return fail("not_requested", "Request the deletion first; the account is removed only after the grace period.", 409);
  if (deletion.deleteAfter > Date.now()) {
    return fail("retention_not_over", `The grace period runs until ${new Date(deletion.deleteAfter).toISOString()}.`, 409, {
      deleteAfter: deletion.deleteAfter,
    });
  }
  const blockers = await erasureBlockers(t.user.id, t.user);
  if (blockers.length) {
    const b = blockers[0];
    return fail(b.code, b.message, b.code === "owner_protected" ? 403 : 409, "groups" in b ? { groups: b.groups } : undefined);
  }
  const body = await readJson<{ confirm?: unknown }>(req);
  if (typeof body?.confirm !== "string" || body.confirm.trim().toLowerCase() !== "delete") {
    return fail("confirmation_required", 'Type "delete" to confirm.', 400);
  }
  // Through the job runner, under the same lock as the Data page's completions.
  const actor = { ...actorOf(g.ctx), req };
  if (await jobLockHolder(DATA_JOBS.deletions)) return fail("busy", "Another deletion is being completed right now. Try again in a moment.", 409);
  const r = await asJob(DATA_JOBS.deletions, actor, () => completeDeletion(t.user.id, deletion, actor), (o) => (o.ok ? "1 account deleted" : "not deleted"));
  if (!r.ok) {
    if ("blockers" in r) return fail(r.blockers[0].code, r.blockers[0].message, 409);
    return fail("erase_failed", `Deletion stopped part-way (${r.error}). The account is still there; try again.`, 500);
  }
  return NextResponse.json({ ok: true, certificate: { id: r.certificate.certificateId, removed: r.certificate.removed } });
}

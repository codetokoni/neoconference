// POST /api/admin/plans/[id]/migrate (plans:write + subscriptions:write)
// { toVersion, fromVersions?: number[], confirm?: true, reason? }
//
// Moves a plan's subscribers on older (or the listed) versions to
// `toVersion`'s terms. Without `confirm` nothing changes: the answer is the
// preview — who moves, and which limits change for them. Periods, prices
// paid and add-ons stay as they are.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { getPlan } from "@/lib/billing/store";
import { migrateSubscribers } from "@/lib/billing/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, ["plans:write", "subscriptions:write"]);
  if (!g.ok) return g.response;
  const plan = await getPlan(params.id);
  if (!plan) return fail("not_found", "That plan was not found.", 404);
  const body = await readJson(req);
  const toVersion = Number(body?.toVersion ?? plan.currentVersion);
  if (!Number.isInteger(toVersion) || toVersion < 1) return fail("bad_version", "Choose the version to move subscribers to.");
  const fromVersions = Array.isArray(body?.fromVersions)
    ? body.fromVersions.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : null;
  const apply = body?.confirm === true;
  const result = await migrateSubscribers(plan.id, toVersion, fromVersions?.length ? fromVersions : null, actorOf(g.ctx), apply);
  if ("error" in result) return fail(result.error, result.message, 400);
  if (!apply) return NextResponse.json({ ok: true, preview: true, rows: result.rows, count: result.rows.length });
  const reason = str(body?.reason, 300) || undefined;
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "plan.migrate",
    targetType: "plan",
    targetId: plan.id,
    targetLabel: plan.current.name,
    before: { versions: [...new Set(result.rows.map((r) => r.fromVersion))].sort(), users: result.rows.map((r) => r.userId) },
    after: { version: toVersion, applied: result.applied, failed: result.failed },
    note: reason,
    outcome: result.failed.length && !result.applied ? "failed" : "ok",
  });
  return NextResponse.json({ ok: true, preview: false, applied: result.applied, failed: result.failed, rows: result.rows });
}

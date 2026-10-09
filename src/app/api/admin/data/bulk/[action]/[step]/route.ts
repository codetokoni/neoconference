// POST /api/admin/data/bulk/<action>/preview | /apply — the data bulk
// actions (src/lib/dataGov/actions.ts) through the preview-token pattern
// (src/lib/admin/bulk.ts):
//
//   complete-deletions  { selection: { userIds } | { due: true } }   destructive
//   restore             { selection: { ids } }                       trash items
//   purge               { selection: { category } }                  destructive
//   retention           { selection: { category, days } }            saves a period
//
// preview -> { count, sample, totals, token, expiresAt, confirmPhrase, extra }
// apply   { selection, token, confirm? } -> the action's result
//
// data:delete (sensitive: a fresh authenticator code) for all four.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { bulkApply, bulkPreview } from "@/lib/admin/bulk";
import { fail, readJson } from "@/lib/admin/http";
import { BULK_ACTIONS, type BulkActionName } from "@/lib/dataGov/actions";
import { recordAdminAction } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: { action: string; step: string } };

export async function POST(req: Request, { params }: Params) {
  const action = BULK_ACTIONS[params.action as BulkActionName];
  if (!action || (params.step !== "preview" && params.step !== "apply")) return fail("not_found", "No such action.", 404);
  const g = await requireAdmin(req, "data:delete");
  if (!g.ok) return g.response;
  const body = await readJson<{ selection?: unknown; token?: unknown; confirm?: unknown }>(req);

  if (params.step === "preview") {
    const selection = action.parse(body?.selection);
    if (selection == null) return fail("bad_selection", "That selection is not valid.", 400);
    // Each action's parse narrows to its own selection type.
    const preview = await bulkPreview(action as never, g.ctx, selection as never);
    return NextResponse.json(preview);
  }

  const r = await bulkApply(action as never, { ...actorOf(g.ctx), req }, body);
  if ("refusal" in r) {
    const refusal = (await r.refusal.clone().json()) as { error: string };
    await recordAdminAction(actorOf(g.ctx), req, {
      action: `data.bulk.${params.action}`,
      targetType: "bulk",
      targetId: action.name,
      outcome: "denied",
      note: refusal.error,
    });
    return r.refusal;
  }
  return NextResponse.json({ ok: true, count: r.count, result: r.output });
}

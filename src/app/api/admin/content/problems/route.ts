// /api/admin/content/problems — content:read
//
// GET ?kind=&stuckMinutes=  Failed uploads and processing, stuck processing,
//     files missing from storage, orphans and likely duplicates, each with
//     the safe actions it allows (src/lib/content/problems.ts).

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { PROBLEM_KINDS, isProblemKind } from "@/lib/content/model";
import { goneOwners, loadRows } from "@/lib/content/admin";
import { backfillState } from "@/lib/content/backfill";
import { detectProblems } from "@/lib/content/problems";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const kind = p.get("kind");
  const stuck = Number(p.get("stuckMinutes"));
  const rows = await loadRows();
  const state = await backfillState();
  const gone = await goneOwners(rows.map((r) => r.ownerId ?? ""));
  const all = detectProblems(rows, {
    now: Date.now(),
    lastPassStartedAt: state.lastCompletePass?.startedAt ?? null,
    goneOwners: gone,
    stuckMinutes: stuck > 0 ? Math.min(stuck, 7 * 24 * 60) : undefined,
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const problems = (isProblemKind(kind) ? all.filter((x) => x.kind === kind) : all).slice(0, 500);
  return NextResponse.json({
    counts: Object.fromEntries(PROBLEM_KINDS.map((k) => [k.id, all.filter((x) => x.kind === k.id).length])),
    problems: problems.map((x) => ({ ...x, files: x.fileIds.map((id) => byId.get(id)).filter(Boolean) })),
    missingCheck: state.lastCompletePass
      ? { at: state.lastCompletePass.finishedAt, objects: state.lastCompletePass.objects }
      : null,
  });
}

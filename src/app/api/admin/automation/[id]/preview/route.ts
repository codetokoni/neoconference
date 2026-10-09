// POST /api/admin/automation/[id]/preview — dry run. ops:read. Lists what the
// rule would do if it ran now — who, and what is already done, cooling down
// or over the per-run limit — without sending, claiming or recording a run.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import { getRule } from "@/lib/automation/store";
import { runRule } from "@/lib/automation/runner";
import { stepUpNeeded } from "@/lib/automation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  const rule = await getRule(params.id);
  if (!rule) return fail("not_found", "No such rule.", 404);
  const now = Date.now();
  const r = await runRule(rule, { now, trigger: "manual", by: g.ctx.email, dryRun: true });
  const step = await stepUpNeeded(rule, now);
  return NextResponse.json({ ok: r.ok, preview: r.detail, error: r.error, stepUp: step });
}

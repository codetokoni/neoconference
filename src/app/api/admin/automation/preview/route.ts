// POST /api/admin/automation/preview — dry run of an unsaved rule (the
// editor's Preview button). automation:write. Validates like create and
// lists what the rule would do now; saves and sends nothing.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { readJson } from "@/lib/admin/http";
import { cleanRuleInput, type Rule } from "@/lib/automation/model";
import { runRule } from "@/lib/automation/runner";
import { editContext, ruleErrorResponse, stepUpNeeded } from "@/lib/automation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const g = await requireAdmin(req, "automation:write");
  if (!g.ok) return g.response;
  const body = await readJson<Record<string, unknown>>(req);
  let input;
  try {
    input = cleanRuleInput(body, editContext());
  } catch (e) {
    return ruleErrorResponse(e);
  }
  const now = Date.now();
  // Previewing an edit: the saved rule's id, so its claims and cooldowns count.
  const id = typeof body?.id === "string" && /^[a-z0-9_]{1,80}$/i.test(body.id) ? body.id : "draft";
  const rule: Rule = { id, ...input, status: "paused", builtIn: null, createdAt: now, createdBy: g.ctx.email, updatedAt: now, updatedBy: g.ctx.email, version: 0 };
  const r = await runRule(rule, { now, trigger: "manual", by: g.ctx.email, dryRun: true });
  return NextResponse.json({ ok: r.ok, preview: r.detail, error: r.error, stepUp: await stepUpNeeded(rule, now) });
}

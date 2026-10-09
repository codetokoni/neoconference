// /api/admin/ops/alerts/rules (ops:write)
//
// POST    { id?, kind, target, threshold, cooldownMinutes, enabled, email, inApp }
//         creates (no id) or replaces a rule. Audited with before/after.
// DELETE  ?id=<ruleId>. Audited.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { deleteRule, isAlertKind, listRules, newRuleId, saveRule, type AlertRule } from "@/lib/ops/alerts";
import { PROBES } from "@/lib/ops/probes";
import { JOBS } from "@/lib/ops/jobRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export async function POST(req: Request) {
  const g = await requireAdmin(req, "ops:write");
  if (!g.ok) return g.response;
  const b = await readJson<Record<string, unknown>>(req);
  if (!isAlertKind(b?.kind)) return fail("bad_kind", "Choose what the rule watches.");
  const kind = b!.kind;
  let target = str(b?.target, 80) || "*";
  if (kind === "service_down" || kind === "service_degraded") {
    if (target !== "*" && !PROBES.some((p) => p.id === target)) return fail("bad_target", "No such service.");
  } else if (kind === "job_failures") {
    if (target !== "*" && !JOBS.some((j) => j.name === target)) return fail("bad_target", "No such job.");
  } else target = "*";
  const threshold = num(b?.threshold, 0, 1e15);
  if (threshold == null) return fail("bad_threshold", "Give a threshold of 0 or more.");
  const cooldownMinutes = num(b?.cooldownMinutes, 0, 60 * 24 * 30);
  if (cooldownMinutes == null) return fail("bad_cooldown", "Give a cooldown between 0 minutes and 30 days.");
  const existing = await listRules();
  const id = str(b?.id, 80) || newRuleId();
  const before = existing.find((r) => r.id === id) ?? null;
  if (b?.id && !before) return fail("not_found", "No such rule.", 404);
  const rule: AlertRule = {
    id,
    kind,
    target,
    threshold,
    cooldownMinutes,
    enabled: b?.enabled !== false,
    email: b?.email !== false,
    inApp: b?.inApp !== false,
    updatedAt: Date.now(),
    updatedBy: g.ctx.email,
  };
  await saveRule(rule);
  const strip = (r: AlertRule | null) => (r ? { kind: r.kind, target: r.target, threshold: r.threshold, cooldownMinutes: r.cooldownMinutes, enabled: r.enabled, email: r.email, inApp: r.inApp } : null);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: before ? "ops.alert_rule.update" : "ops.alert_rule.create",
    targetType: "alert_rule",
    targetId: id,
    targetLabel: `${kind} ${target}`,
    before: strip(before),
    after: strip(rule),
  });
  return NextResponse.json({ ok: true, rule }, { status: before ? 200 : 201 });
}

export async function DELETE(req: Request) {
  const g = await requireAdmin(req, "ops:write");
  if (!g.ok) return g.response;
  const id = new URL(req.url).searchParams.get("id") || "";
  const before = (await listRules()).find((r) => r.id === id);
  if (!before) return fail("not_found", "No such rule.", 404);
  await deleteRule(id);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "ops.alert_rule.delete",
    targetType: "alert_rule",
    targetId: id,
    targetLabel: `${before.kind} ${before.target}`,
    before,
  });
  return NextResponse.json({ ok: true });
}

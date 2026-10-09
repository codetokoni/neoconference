// /api/admin/features — turn features on or off for everyone and per plan.
//
// GET   (features:write, no fresh code needed to look)  switches, per-plan
//       values (catalog features read from the plan catalog), account overrides
// PATCH (features:write + fresh code)  { global?: { feature: boolean }, perPlan?: { feature: { plan: boolean } } }
//
// Precedence: global off > account allow/deny > per-plan switch > plan default
// (src/lib/platform/model.ts resolveFeature).

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { getFeatureControls, listAccountOverrides, saveFeatureControls } from "@/lib/platform/settings";
import { catalogPlanValues } from "@/lib/platform/features";
import { FEATURES, SettingsInputError, cleanPerPlan, isFeatureKey, type FeatureControls, type FeatureKey } from "@/lib/platform/model";
import { PLANS } from "@/lib/planLimits";
import { emitPlatformEvent } from "@/lib/platform/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "features:write", { readOnly: true });
  if (!g.ok) return g.response;
  const [controls, accounts, catalog] = await Promise.all([getFeatureControls(), listAccountOverrides(), catalogPlanValues()]);
  return NextResponse.json({
    ok: true,
    features: FEATURES,
    plans: PLANS,
    global: controls.global,
    perPlan: controls.perPlan,
    catalog,
    accounts,
    maintenance: controls.maintenance,
  });
}

export async function PATCH(req: Request) {
  const g = await requireAdmin(req, "features:write");
  if (!g.ok) return g.response;
  const body = await readJson<{ global?: unknown; perPlan?: unknown }>(req);
  const current = await getFeatureControls();
  const next: FeatureControls = { ...current, global: { ...current.global }, perPlan: { ...current.perPlan } };

  if (body?.global && typeof body.global === "object") {
    for (const [f, v] of Object.entries(body.global as Record<string, unknown>)) {
      if (!isFeatureKey(f)) return fail("unknown_feature", `No feature called ${f}.`);
      if (typeof v !== "boolean") return fail("invalid_value", "A global switch is true (on) or false (off).");
      if (v) delete next.global[f];
      else next.global[f] = false;
    }
  }
  if (body?.perPlan && typeof body.perPlan === "object") {
    try {
      // Per feature: the row given replaces the stored one; null clears it.
      const raw = body.perPlan as Record<string, unknown>;
      const cleaned = cleanPerPlan(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null)));
      for (const f of Object.keys(raw)) {
        if (!isFeatureKey(f)) return fail("unknown_feature", `No feature called ${f}.`);
        const row = cleaned[f as FeatureKey];
        if (row) next.perPlan[f as FeatureKey] = row;
        else delete next.perPlan[f as FeatureKey];
      }
    } catch (err) {
      if (err instanceof SettingsInputError) return fail(err.code, err.message);
      throw err;
    }
  }

  const saved = await saveFeatureControls(next);
  const changes = diff(
    { global: current.global, perPlan: current.perPlan } as Record<string, unknown>,
    { global: saved.global, perPlan: saved.perPlan } as Record<string, unknown>,
  );
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "feature.update",
    targetType: "features",
    targetId: "platform",
    targetLabel: "feature switches",
    before: changes.before,
    after: changes.after,
  });
  await emitPlatformEvent("feature.changed", { global: saved.global, perPlan: saved.perPlan });
  return NextResponse.json({ ok: true, global: saved.global, perPlan: saved.perPlan });
}

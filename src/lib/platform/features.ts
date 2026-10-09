// src/lib/platform/features.ts
//
// The one helper every enforcement point asks: is this feature on for this
// account? Precedence (src/lib/platform/model.ts resolveFeature):
//
//   global off  >  account allow/deny  >  per-plan switch  >  plan default
//
// The caller passes the plan and, for the features the plan catalog
// carries (recording, translation, livestream, breakouts, branding), the
// plan's own value it has already worked out — so the plan catalog stays
// the only source of per-plan values for those, and this file never second-
// guesses it.
//
//   const f = await featureDecision("recording", { userId, plan, planAllows: limits.recording });
//   if (!f.enabled) return featureRefusal(f);

import { NextResponse } from "next/server";
import {
  featureRefusalMessage,
  resolveFeature,
  type FeatureDecision,
  type FeatureKey,
} from "@/lib/platform/model";
import { getAccountOverrides, getFeatureControls } from "@/lib/platform/settings";
import { PLANS, getPlanLimits, type Plan } from "@/lib/planLimits";

export interface FeatureQuery {
  /** The account the feature is billed to (usually the meeting's owner). */
  userId: string | null | undefined;
  plan: Plan;
  planAllows?: boolean;
  exempt?: boolean;
}

export async function featureDecision(feature: FeatureKey, q: FeatureQuery): Promise<FeatureDecision> {
  const [controls, overrides] = await Promise.all([getFeatureControls(), q.userId ? getAccountOverrides(q.userId) : Promise.resolve({})]);
  return resolveFeature(controls, feature, {
    plan: q.plan,
    planAllows: q.planAllows,
    exempt: q.exempt,
    override: (overrides as Partial<Record<FeatureKey, "allow" | "deny">>)[feature] ?? null,
  });
}

export async function isFeatureEnabled(feature: FeatureKey, q: FeatureQuery): Promise<boolean> {
  return (await featureDecision(feature, q)).enabled;
}

/** Several features for one account in one read (the LiveKit token's planLimits). */
export async function featureDecisions(features: FeatureKey[], q: Omit<FeatureQuery, "planAllows"> & { planAllows?: Partial<Record<FeatureKey, boolean>> }) {
  const [controls, overrides] = await Promise.all([getFeatureControls(), q.userId ? getAccountOverrides(q.userId) : Promise.resolve({})]);
  const out = {} as Record<FeatureKey, FeatureDecision>;
  for (const f of features) {
    out[f] = resolveFeature(controls, f, {
      plan: q.plan,
      planAllows: q.planAllows?.[f],
      exempt: q.exempt,
      override: (overrides as Partial<Record<FeatureKey, "allow" | "deny">>)[f] ?? null,
    });
  }
  return out;
}

/**
 * The per-plan values of the features the plan catalog carries, for the
 * admin's feature matrix (read-only there; they are edited in Plans).
 * The interface phase 3's catalog plugs into: today the built-in tier
 * limits; with the catalog, each tier's current version.
 */
export async function catalogPlanValues(): Promise<Record<Plan, Partial<Record<FeatureKey, boolean>>>> {
  const out = {} as Record<Plan, Partial<Record<FeatureKey, boolean>>>;
  for (const plan of PLANS) {
    const l = getPlanLimits(plan);
    out[plan] = { recording: l.recording, translation: l.translation, livestream: l.livestream, breakouts: l.breakouts, branding: l.branding };
  }
  return out;
}

/** The refusal every enforcement point sends when a feature is off for a non-plan reason. */
export function featureRefusalBody(d: FeatureDecision) {
  return { ok: false, error: "feature_disabled", feature: d.feature, scope: d.source, message: featureRefusalMessage(d) };
}

export function featureRefusal(d: FeatureDecision): NextResponse {
  return NextResponse.json(featureRefusalBody(d), { status: 403 });
}

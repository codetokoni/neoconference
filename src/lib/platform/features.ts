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
import { PLANS, getPlanLimits, type Plan, type PlanLimits } from "@/lib/planLimits";

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
 * Each tier's current version in the plan catalog (src/lib/billing/store.ts),
 * or the built-in tier limits when the catalog cannot be read. Existing
 * subscribers keep the version they bought; the enforcement points use
 * the account's own limits (getPlanLimitsForUserId).
 */
export async function catalogPlanValues(): Promise<Record<Plan, Partial<Record<FeatureKey, boolean>>>> {
  const pick = (l: PlanLimits) => ({ recording: l.recording, translation: l.translation, livestream: l.livestream, breakouts: l.breakouts, branding: l.branding });
  const out = {} as Record<Plan, Partial<Record<FeatureKey, boolean>>>;
  for (const plan of PLANS) out[plan] = pick(getPlanLimits(plan));
  try {
    const { listPlans } = await import("@/lib/billing/store");
    for (const p of await listPlans()) if ((PLANS as string[]).includes(p.id)) out[p.id as Plan] = pick(p.current.limits);
  } catch (err) {
    console.error("[feature-controls] plan catalog unreadable; showing built-in tiers", err);
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

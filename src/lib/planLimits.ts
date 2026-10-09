// src/lib/planLimits.ts
//
// Pure plan-limit data — no Clerk / server-only imports. Split out
// from src/lib/plan.ts so client components (e.g. PricingTiers) can
// read the shape of a plan without dragging @clerk/nextjs/server into
// the client bundle, which fails the "server-only cannot be imported
// from a Client Component" build check.
//
// src/lib/plan.ts re-exports everything here for server callers, so
// existing `import { Plan, getPlanLimits } from "@/lib/plan"` sites
// keep working.

export type Plan = "free" | "starter" | "pro" | "business" | "enterprise";

export const PLANS: Plan[] = ["free", "starter", "pro", "business", "enterprise"];

export function isPlan(value: unknown): value is Plan {
    return typeof value === "string" && (PLANS as string[]).includes(value);
}

export type PlanMetadata = {
    plan?: Plan;
    planExpiresAt?: number;
};

export function isPlanExpired(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== "object") return false;
    const m = metadata as Record<string, unknown>;
    const expiresAt = m.planExpiresAt;
    if (typeof expiresAt !== "number") return false;
    return Date.now() > expiresAt;
}

export function computePlanExpiry(billingCycle: "monthly" | "annual"): number {
    const ms = billingCycle === "annual" ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    return Date.now() + ms;
}

export type PlanLimits = {
    meetingMinutes: number;
    maxParticipants: number;
    lifetimeMeetingCap: number;
    recording: boolean;
    recordingHoursPerMonth: number;
    breakouts: boolean;
    branding: boolean;
    livestream: boolean;
    /**
     * Whether this plan may offer live translation, and so whether its
     * meetings may be created with languages.
     *
     * A boolean rather than a count on purpose: every numeric limit in this
     * file uses 0 to mean "unlimited" (see enterprise), which would make
     * "no languages at all" unexpressible. Translation is a feature you
     * have or don't, like recording and breakouts.
     */
    translation: boolean;
};

export function getPlanLimits(plan: Plan): PlanLimits {
    switch (plan) {
      case "enterprise":
              return {
                        meetingMinutes: 0,
                        maxParticipants: 0,
                        lifetimeMeetingCap: 0,
                        recording: true,
                        recordingHoursPerMonth: 50,
                        breakouts: true,
                        branding: true,
                        livestream: true,
                        translation: true,
              };
      case "business":
              return {
                        meetingMinutes: 0,
                        maxParticipants: 500,
                        lifetimeMeetingCap: 0,
                        recording: true,
                        recordingHoursPerMonth: 50,
                        breakouts: true,
                        branding: true,
                        livestream: false,
                        translation: true,
              };
      case "pro":
              return {
                        meetingMinutes: 0,
                        maxParticipants: 200,
                        lifetimeMeetingCap: 0,
                        recording: true,
                        recordingHoursPerMonth: 10,
                        breakouts: true,
                        branding: false,
                        livestream: false,
                        translation: true,
              };
      case "starter":
              return {
                        meetingMinutes: 120,
                        maxParticipants: 100,
                        lifetimeMeetingCap: 0,
                        recording: false,
                        recordingHoursPerMonth: 0,
                        breakouts: false,
                        branding: false,
                        livestream: false,
                        translation: false,
              };
      case "free":
      default:
              return {
                        meetingMinutes: 60,
                        maxParticipants: 30,
                        lifetimeMeetingCap: 5,
                        recording: false,
                        recordingHoursPerMonth: 0,
                        breakouts: false,
                        branding: false,
                        livestream: false,
                        translation: false,
              };
    }
}

/**
 * PlanLimits plus the limits the admin plan catalog can also set
 * (src/lib/billing/model.ts LIMIT_FIELDS says which are enforced).
 * `groupMembers` null = as many as the plan allows in a meeting, which is
 * how group sizes were decided before the catalog existed.
 */
export type PlanFeatureLimits = PlanLimits & {
    seats: number;
    storageGb: number;
    groupMembers: number | null;
};

/** The built-in limits of a tier, with the catalog-only fields at their defaults. */
export function extendedLimits(plan: Plan): PlanFeatureLimits {
    return { ...getPlanLimits(plan), seats: plan === "enterprise" ? 0 : 1, storageGb: 0, groupMembers: null };
}

const NUMERIC_LIMITS = ["meetingMinutes", "maxParticipants", "lifetimeMeetingCap", "recordingHoursPerMonth", "seats", "storageGb"] as const;
const BOOLEAN_LIMITS = ["recording", "breakouts", "branding", "livestream", "translation"] as const;

/** Keep only well-formed limit values from an untrusted object, over `base`. */
export function mergeLimits(base: PlanFeatureLimits, raw: unknown): PlanFeatureLimits {
    const out: PlanFeatureLimits = { ...base };
    if (!raw || typeof raw !== "object") return out;
    const r = raw as Record<string, unknown>;
    for (const k of NUMERIC_LIMITS) {
        const v = r[k];
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
    }
    for (const k of BOOLEAN_LIMITS) {
        if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
    }
    if (r.groupMembers === null) out.groupMembers = null;
    else if (typeof r.groupMembers === "number" && Number.isFinite(r.groupMembers) && r.groupMembers >= 0) out.groupMembers = Math.floor(r.groupMembers);
    return out;
}

/**
 * The limits an account's stored plan gives it. A subscription made from
 * the admin plan catalog writes the limits of the version bought (plus
 * add-ons and custom terms) to publicMetadata.planLimits, so editing a plan
 * later does not change what existing subscribers have. Without that
 * snapshot — every account from before the catalog — the tier's built-in
 * limits apply, which are version 1 of each tier in the catalog.
 */
export function limitsFromMetadata(metadata: unknown): PlanFeatureLimits {
    const plan = readPlanFromMetadata(metadata);
    const base = extendedLimits(plan);
    if (plan === "free" || !metadata || typeof metadata !== "object") return base;
    const m = metadata as Record<string, unknown>;
    return m.plan === plan ? mergeLimits(base, m.planLimits) : base;
}

export function readPlanFromMetadata(metadata: unknown): Plan {
    if (metadata && typeof metadata === "object" && "plan" in metadata) {
          const p = (metadata as Record<string, unknown>).plan;
          if (isPlan(p)) {
              if (isPlanExpired(metadata)) return "free";
                  return p;
          }
    }
    return "free";
}

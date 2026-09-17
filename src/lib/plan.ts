// src/lib/plan.ts
//
// Server-side plan helpers. The pure plan-limit data lives in
// src/lib/planLimits.ts (no server-only imports) so client
// components can safely read it; this file re-exports that surface
// AND adds the Clerk-backed lookups that only make sense on the
// server (getCurrentPlan, getPlanForUserId, checkLifetimeCap,
// incrementMeetingsCreated).
//
// Bootstrap: if BOOTSTRAP_BUSINESS_EMAIL matches the signed-in user's primary
// email, that user is promoted to the "business" plan automatically (mirrors
// the BOOTSTRAP_ADMIN_EMAIL pattern in roles.ts). This lets the project owner
// keep using the app at full capability without integrating payments first.
//
// Lifetime meeting cap: only the "free" plan has a finite lifetimeMeetingCap.
// It is tracked in Clerk publicMetadata.meetingsCreated (number, default 0)
// and incremented at each of the three meeting-creation entry points:
//   /api/events/create, /api/events/instant, and the adoptOrphanRoom path
//   inside /api/livekit/token.

import { auth, clerkClient } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/roles";
import {
    type Plan,
    getPlanLimits,
    readPlanFromMetadata,
} from "@/lib/planLimits";

// Re-export the pure surface so `import { ... } from "@/lib/plan"`
// keeps working everywhere it did before the split.
export {
    type Plan,
    type PlanLimits,
    type PlanMetadata,
    PLANS,
    isPlan,
    isPlanExpired,
    computePlanExpiry,
    getPlanLimits,
    readPlanFromMetadata,
} from "@/lib/planLimits";

function readMeetingsCreated(metadata: unknown): number {
    if (metadata && typeof metadata === "object" && "meetingsCreated" in metadata) {
          const n = (metadata as Record<string, unknown>).meetingsCreated;
          if (typeof n === "number" && Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
    return 0;
}

/**
 * Get the current signed-in user's plan. Bootstrap: if the user's primary
 * email matches BOOTSTRAP_BUSINESS_EMAIL, promote them to "business" and
 * persist that on first read.
 *
 * Returns null if the user is not signed in.
 */
export async function getCurrentPlan(): Promise<Plan | null> {
    const { userId } = await auth();
    if (!userId) return null;

  const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const emails = (user.emailAddresses || []).map((e) => e.emailAddress.toLowerCase());

  // Permanent admins (ADMIN_EMAILS) get the highest plan tier so the in-room
  // countdown widget and participant cap don't apply to app operators. Not
  // persisted — env var stays authoritative.
  if (emails.some((e) => isAdmin(e))) return "business";

  const existing = readPlanFromMetadata(user.publicMetadata);
    if (existing !== "free") return existing;

  const bootstrap = (process.env.BOOTSTRAP_BUSINESS_EMAIL || "").trim().toLowerCase();
    if (bootstrap && emails.includes(bootstrap)) {
          await client.users.updateUserMetadata(userId, {
                  publicMetadata: { ...(user.publicMetadata ?? {}), plan: "business" },
          });
          return "business";
    }

  return existing;
}

/**
 * Look up the plan for a specific userId (used when issuing tokens for a
 * meeting whose host is not the current user). Honors ADMIN_EMAILS the same
 * way getCurrentPlan does, so an admin's own rooms run without plan limits
 * regardless of what publicMetadata.plan says.
 */
export async function getPlanForUserId(userId: string): Promise<Plan> {
    if (!userId) return "free";
    try {
          const client = await clerkClient();
          const user = await client.users.getUser(userId);
          const explicit = readPlanFromMetadata(user.publicMetadata);
          if (explicit !== "free") return explicit;
          const emails = (user.emailAddresses || []).map((e) => e.emailAddress.toLowerCase());
          if (emails.some((e) => isAdmin(e))) return "business";
          return explicit;
    } catch {
          return "free";
    }
}

/**
 * Check whether the given user is blocked by the lifetime meeting cap.
 * Returns { blocked, used, cap, plan }.
 *
 * - blocked=true means the user has hit or exceeded their cap and should be
 *   refused a new meeting creation.
 * - cap=0 means unlimited (never blocks).
 * - Admins (ADMIN_EMAILS) are never blocked.
 */
export async function checkLifetimeCap(
    userId: string,
  ): Promise<{ blocked: boolean; used: number; cap: number; plan: Plan }> {
    if (!userId) {
          return { blocked: false, used: 0, cap: 0, plan: "free" };
    }
    try {
          const client = await clerkClient();
          const user = await client.users.getUser(userId);
          const emails = (user.emailAddresses || []).map((e) => e.emailAddress.toLowerCase());
          if (emails.some((e) => isAdmin(e))) {
                  return { blocked: false, used: 0, cap: 0, plan: "business" };
          }
          const plan = readPlanFromMetadata(user.publicMetadata);
          const limits = getPlanLimits(plan);
          const used = readMeetingsCreated(user.publicMetadata);
          const cap = limits.lifetimeMeetingCap;
          if (cap <= 0) return { blocked: false, used, cap: 0, plan };
          return { blocked: used >= cap, used, cap, plan };
    } catch {
          // Fail-open on Clerk errors — don't lock users out of the app on infra glitches.
      return { blocked: false, used: 0, cap: 0, plan: "free" };
    }
}

/**
 * Increment Clerk publicMetadata.meetingsCreated by 1. Only does work for
 * plans with a finite lifetimeMeetingCap (currently just "free") — for paid
 * plans the counter is irrelevant, so we skip the round-trip.
 *
 * Best-effort: swallows errors so a Clerk hiccup doesn't kill meeting creation.
 */
export async function incrementMeetingsCreated(userId: string): Promise<void> {
    if (!userId) return;
    try {
          const client = await clerkClient();
          const user = await client.users.getUser(userId);
          const plan = readPlanFromMetadata(user.publicMetadata);
          const limits = getPlanLimits(plan);
          if (limits.lifetimeMeetingCap <= 0) return;
          const used = readMeetingsCreated(user.publicMetadata);
          await client.users.updateUserMetadata(userId, {
                  publicMetadata: {
                            ...(user.publicMetadata ?? {}),
                            meetingsCreated: used + 1,
                  },
          });
    } catch (e) {
          // eslint-disable-next-line no-console
      console.error("[plan] incrementMeetingsCreated failed:", e);
    }
}

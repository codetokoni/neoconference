// src/lib/plan.ts
//
// User-plan helpers. The plan lives in Clerk publicMetadata.plan and is one of:
//   "free" | "starter" | "pro" | "business" | "enterprise"
//
// Bootstrap: if BOOTSTRAP_BUSINESS_EMAIL matches the signed-in user's primary
// email, that user is promoted to the "business" plan automatically (mirrors
// the BOOTSTRAP_ADMIN_EMAIL pattern in roles.ts). This lets the project owner
// keep using the app at full capability without integrating payments first.
//
// Plan limits are enforced server-side wherever possible (token route +
// events/create + events/instant), with thin client mirrors for UX
// (timer banner, locked CTAs).
//
// Lifetime meeting cap: only the "free" plan has a finite lifetimeMeetingCap.
// It is tracked in Clerk publicMetadata.meetingsCreated (number, default 0)
// and incremented at each of the three meeting-creation entry points:
//   /api/events/create, /api/events/instant, and the adoptOrphanRoom path
//   inside /api/livekit/token.

import { auth, clerkClient } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/roles";

export type Plan = "free" | "starter" | "pro" | "business" | "enterprise";

export const PLANS: Plan[] = ["free", "starter", "pro", "business", "enterprise"];

export function isPlan(value: unknown): value is Plan {
    return typeof value === "string" && (PLANS as string[]).includes(value);
}

/**
 * Per-plan feature limits. Use these to drive both server-side gates and
 * UI affordances. Numbers are intentional — see /pricing for the source-of-truth.
 */
export type PlanLimits = {
    /** Hard cap on a single meeting's length (0 = unlimited). */
    meetingMinutes: number;
    /** Max simultaneous participants in one room (0 = unlimited). */
    maxParticipants: number;
    /** Lifetime cap on number of meetings this user can create (0 = unlimited). */
    lifetimeMeetingCap: number;
    /** Cloud recording allowed at all. */
    recording: boolean;
    /** Soft cap: recording hours per billing month (0 = unlimited; ignored if recording=false). */
    recordingHoursPerMonth: number;
    /** Breakout rooms allowed. */
    breakouts: boolean;
    /** Custom branding (logo + room URL) allowed. */
    branding: boolean;
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
              };
    }
}

export function readPlanFromMetadata(metadata: unknown): Plan {
    if (metadata && typeof metadata === "object" && "plan" in metadata) {
          const p = (metadata as Record<string, unknown>).plan;
          if (isPlan(p)) return p;
    }
    return "free";
}

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

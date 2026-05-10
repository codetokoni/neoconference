// src/lib/plan.ts
//
// User-plan helpers. The plan lives in Clerk publicMetadata.plan and is one of:
//   "free" | "pro" | "business"
//
// Bootstrap: if BOOTSTRAP_BUSINESS_EMAIL matches the signed-in user's primary
// email, that user is promoted to the "business" plan automatically (mirrors
// the BOOTSTRAP_ADMIN_EMAIL pattern in roles.ts). This lets the project owner
// keep using the app at full capability without integrating payments first.
//
// Plan limits are enforced server-side wherever possible (token route),
// with thin client mirrors for UX (timer banner, locked CTAs).

import { auth, clerkClient } from "@clerk/nextjs/server";

export type Plan = "free" | "pro" | "business";

export const PLANS: Plan[] = ["free", "pro", "business"];

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
  /** Max simultaneous participants in one room. */
  maxParticipants: number;
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
    case "business":
      return {
        meetingMinutes: 0,
        maxParticipants: 300,
        recording: true,
        recordingHoursPerMonth: 50,
        breakouts: true,
        branding: true,
      };
    case "pro":
      return {
        meetingMinutes: 0,
        maxParticipants: 100,
        recording: true,
        recordingHoursPerMonth: 10,
        breakouts: true,
        branding: false,
      };
    case "free":
    default:
      return {
        meetingMinutes: 20,
        maxParticipants: 10,
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
  const existing = readPlanFromMetadata(user.publicMetadata);

  if (existing !== "free") return existing;

  const bootstrap = (process.env.BOOTSTRAP_BUSINESS_EMAIL || "").trim().toLowerCase();
  if (bootstrap) {
    const emails = (user.emailAddresses || []).map((e) => e.emailAddress.toLowerCase());
    if (emails.includes(bootstrap)) {
      await client.users.updateUserMetadata(userId, {
        publicMetadata: { ...(user.publicMetadata ?? {}), plan: "business" },
      });
      return "business";
    }
  }

  return existing;
}

/**
 * Look up the plan for a specific userId (used when issuing tokens for a
 * meeting whose host is not the current user).
 */
export async function getPlanForUserId(userId: string): Promise<Plan> {
  if (!userId) return "free";
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    return readPlanFromMetadata(user.publicMetadata);
  } catch {
    return "free";
  }
}

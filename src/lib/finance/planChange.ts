// src/lib/finance/planChange.ts
//
// The one plan change billing makes: ending a refunded plan now, through
// endSubscriptionNow (src/lib/billing/subscriptions.ts), which cancels a
// running subscription record — record, history and Clerk together — or
// clears a plan granted before records existed. The owner's plan is never
// changed (src/lib/admin/owner.ts).

import { clerkClient } from "@clerk/nextjs/server";
import { isOwnerEmailList, type ClerkEmailish } from "@/lib/admin/owner";
import { OwnerProtected, endSubscriptionNow, getSubscription, type Actor } from "@/lib/billing/subscriptions";
import { summarize } from "@/lib/billing/model";
import { forgetUser } from "@/lib/finance/ledger";

export async function isOwnerAccount(userId: string): Promise<boolean> {
  try {
    const client = await clerkClient();
    const u = await client.users.getUser(userId);
    return isOwnerEmailList((u.emailAddresses ?? []) as ClerkEmailish[]);
  } catch {
    return false;
  }
}

export interface PlanSnapshot {
  plan: string | null;
  planExpiresAt: number | null;
  subscription?: ReturnType<typeof summarize>;
}

/**
 * Put the account on Free now. Returns the plan before and after for the
 * audit entry. Throws "owner_protected" for the owner.
 */
export async function endPlanNow(userId: string, actor: Actor, note: string): Promise<{ before: PlanSnapshot; after: PlanSnapshot }> {
  if (await isOwnerAccount(userId)) throw new Error("owner_protected");
  const client = await clerkClient();
  const md = ((await client.users.getUser(userId)).publicMetadata ?? {}) as Record<string, unknown>;
  const before: PlanSnapshot = {
    plan: typeof md.plan === "string" ? md.plan : null,
    planExpiresAt: typeof md.planExpiresAt === "number" ? md.planExpiresAt : null,
    subscription: summarize(await getSubscription(userId)),
  };
  try {
    const r = await endSubscriptionNow(userId, { actor, reason: note });
    forgetUser(userId);
    return { before, after: { plan: "free", planExpiresAt: null, subscription: summarize(r.subscription) } };
  } catch (e) {
    if (e instanceof OwnerProtected) throw new Error("owner_protected");
    throw e;
  }
}

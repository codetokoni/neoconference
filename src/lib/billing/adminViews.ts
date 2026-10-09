// src/lib/billing/adminViews.ts — shared by the /api/admin plan and
// subscription routes: who a subscription action is aimed at (and the
// refusal for the owner), subscriber counts, and the row shape lists use.

import { clerkClient } from "@clerk/nextjs/server";
import type { NextResponse } from "next/server";
import { fail } from "@/lib/admin/http";
import { isOwnerEmailList, type ClerkEmailish } from "@/lib/admin/owner";
import { hasAccess, type Subscription } from "@/lib/billing/model";
import { listSubscriptions } from "@/lib/billing/subscriptions";

export interface Target {
  userId: string;
  email: string;
  name: string;
  isOwner: boolean;
  metadata: Record<string, unknown>;
}

export async function loadTarget(userId: string): Promise<Target | null> {
  if (!userId) return null;
  try {
    const client = await clerkClient();
    const u = await client.users.getUser(userId);
    const list = (u.emailAddresses ?? []) as ClerkEmailish[];
    const x = u as { firstName?: string | null; lastName?: string | null; username?: string | null; primaryEmailAddress?: { emailAddress?: string } | null };
    const email = (x.primaryEmailAddress?.emailAddress || list[0]?.emailAddress || "").toLowerCase();
    return {
      userId,
      email,
      name: [x.firstName, x.lastName].filter(Boolean).join(" ") || x.username || email,
      isOwner: isOwnerEmailList(list),
      metadata: (u.publicMetadata ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/** The target, or the response that refuses: unknown account, or the platform owner. */
export async function subscriptionTarget(userId: string): Promise<{ ok: true; target: Target } | { ok: false; response: NextResponse }> {
  const target = await loadTarget(userId);
  if (!target) return { ok: false, response: fail("not_found", "There is no account with that id.", 404) };
  if (target.isOwner) {
    return {
      ok: false,
      response: fail("owner_protected", "The platform owner's account is always Enterprise. Its plan cannot be assigned, changed, paused or cancelled.", 403),
    };
  }
  return { ok: true, target };
}

export type SubscriberCounts = Record<string, { total: number; live: number; byVersion: Record<string, number> }>;

export async function subscriberCounts(subs?: Subscription[]): Promise<SubscriberCounts> {
  const now = Date.now();
  const out: SubscriberCounts = {};
  for (const s of subs ?? (await listSubscriptions())) {
    const c = (out[s.planId] ??= { total: 0, live: 0, byVersion: {} });
    c.total++;
    if (hasAccess(s, now) || s.status === "paused") {
      c.live++;
      c.byVersion[String(s.version)] = (c.byVersion[String(s.version)] ?? 0) + 1;
    }
  }
  return out;
}

export function subRow(s: Subscription) {
  return {
    userId: s.userId,
    email: s.email,
    planId: s.planId,
    planName: s.snapshot.name,
    baseTier: s.baseTier,
    version: s.version,
    status: s.status,
    cycle: s.cycle,
    periodEnd: s.periodEnd,
    endedAt: s.endedAt,
    source: s.source,
    pricePaid: s.pricePaid,
    scheduled: s.scheduled,
    addOns: s.addOns.map((a) => a.name),
    custom: !!s.custom,
    live: hasAccess(s, Date.now()),
  };
}

export type SubRow = ReturnType<typeof subRow>;

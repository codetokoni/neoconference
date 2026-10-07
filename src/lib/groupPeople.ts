// src/lib/groupPeople.ts
//
// Where group members come from: Clerk accounts, looked up by id or exact email.
// Server-only (Clerk backend API); the group store itself stays pure.

import { clerkClient, currentUser } from "@clerk/nextjs/server";
import {
  GROUP_LIMITS,
  claimPendingMemberships,
  pendingKeyFor,
  type Group,
  type MemberLimit,
  type NewMember,
} from "@/lib/groupStore";
import { clerkIdsForKcHandles } from "@/lib/kcHandle";
import type { CreateMeetingDeps } from "@/lib/groupMeetings";
import { checkLifetimeCap, getPlanForUserId, getPlanLimits, incrementMeetingsCreated } from "@/lib/plan";

type ClerkUserLike = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{
    id: string;
    emailAddress: string;
    verification?: { status?: string | null } | null;
  }>;
  publicMetadata?: unknown;
};

function primaryEmail(u: ClerkUserLike): string | undefined {
  const list = u.emailAddresses || [];
  const primary = list.find((e) => e.id === u.primaryEmailAddressId) ?? list[0];
  return primary?.emailAddress?.toLowerCase() || undefined;
}

/** A Clerk user as a prospective member: their id, a name to show, an email. */
export function memberFromClerkUser(u: ClerkUserLike): NewMember {
  const email = primaryEmail(u);
  const name =
    [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
    u.username ||
    email?.split("@")[0] ||
    "Member";
  return { userId: u.id, name, ...(email ? { email } : {}) };
}

/** The signed-in caller as a member, or null when signed out. */
export async function currentMember(): Promise<NewMember | null> {
  const u = await currentUser().catch(() => null);
  return u ? memberFromClerkUser(u) : null;
}

/**
 * Accounts for exact email addresses. Not a directory search: an address with
 * no account is simply reported missing, and nothing else about who is
 * signed up is revealed.
 */
export async function membersByEmail(
  emails: string[]
): Promise<{ found: NewMember[]; missing: string[] }> {
  const wanted = Array.from(new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  if (wanted.length === 0) return { found: [], missing: [] };
  const cc = await clerkClient();
  const list = await cc.users.getUserList({ emailAddress: wanted, limit: 100 });
  const found: NewMember[] = [];
  const matched = new Set<string>();
  for (const u of list.data) {
    found.push(memberFromClerkUser(u));
    for (const e of u.emailAddresses || []) matched.add(e.emailAddress.toLowerCase());
  }
  return { found, missing: wanted.filter((e) => !matched.has(e)) };
}

/**
 * Accounts for KingsChat handles (normalized). A handle nobody has signed in
 * with is reported missing, as is one whose account has since gone.
 */
export async function membersByKcHandle(
  handles: string[]
): Promise<{ found: NewMember[]; missing: string[] }> {
  const wanted = Array.from(new Set(handles));
  if (wanted.length === 0) return { found: [], missing: [] };
  const ids = await clerkIdsForKcHandles(wanted);
  const { found } = await membersById(Array.from(new Set(ids.values())));
  const have = new Set(found.map((m) => m.userId));
  return { found, missing: wanted.filter((h) => !have.has(ids.get(h) ?? "")) };
}

/**
 * Make good on group places held for this person: their verified email
 * addresses and the KingsChat handle they signed in with (publicMetadata,
 * which only the server writes). Never throws — a sign-in or a list of groups
 * must not fail over it. Returns the groups they joined.
 */
export async function claimPendingFor(u: ClerkUserLike): Promise<Group[]> {
  try {
    const keys: string[] = [];
    for (const e of u.emailAddresses || []) {
      if (e.verification?.status !== "verified") continue;
      const key = pendingKeyFor("email", e.emailAddress);
      if (key) keys.push(key);
    }
    const handle = (u.publicMetadata as { kingschat?: { username?: string } } | undefined)?.kingschat?.username;
    const kcKey = handle ? pendingKeyFor("kc", handle) : null;
    if (kcKey) keys.push(kcKey);
    if (keys.length === 0) return [];
    return await claimPendingMemberships(memberFromClerkUser(u), keys);
  } catch (err) {
    console.warn("[groupPeople] claiming pending memberships failed", err);
    return [];
  }
}

/** claimPendingFor() for whoever is signed in. */
export async function claimPendingForCaller(): Promise<Group[]> {
  const u = await currentUser().catch(() => null);
  return u ? claimPendingFor(u) : [];
}

/** Accounts for Clerk user ids; ids with no account are reported missing. */
export async function membersById(ids: string[]): Promise<{ found: NewMember[]; missing: string[] }> {
  const wanted = Array.from(new Set(ids.map((i) => i.trim()).filter(Boolean)));
  if (wanted.length === 0) return { found: [], missing: [] };
  const cc = await clerkClient();
  const list = await cc.users.getUserList({ userId: wanted, limit: 100 });
  const found = list.data.map(memberFromClerkUser);
  const have = new Set(found.map((m) => m.userId));
  return { found, missing: wanted.filter((i) => !have.has(i)) };
}

/* -------------------------------------------------------------------------- */
/*  Meeting creation gates                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The gates /api/events/create and /api/events/instant apply, for group
 * meetings: the Free lifetime cap and its counter, and the owner's recurring
 * roles. groupMeetings.ts calls them with the group Owner's id.
 */
export const meetingGates: CreateMeetingDeps = {
  checkCap: (userId) => checkLifetimeCap(userId),
  incrementCap: (userId) => incrementMeetingsCreated(userId),
  applyRecurringRoles: async (eventId, ownerUserId) => {
    const { applyRecurringRoles } = await import("@/lib/recurring-roles");
    await applyRecurringRoles(eventId, ownerUserId);
  },
};

/** The site's own origin, as /api/events/instant works it out. */
export function siteOrigin(req: Request): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/+$/, "");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("host") ?? "localhost:3000";
  return proto + "://" + host;
}

/**
 * A group's member limit, from its Owner's plan: as many members as the plan
 * allows people in a meeting (everyone invited can then come), capped at
 * GROUP_LIMITS.membersMax. An unlimited plan gets the cap.
 */
export async function memberLimitFor(ownerUserId: string): Promise<MemberLimit> {
  try {
    const plan = await getPlanForUserId(ownerUserId);
    const max = getPlanLimits(plan).maxParticipants;
    return { cap: max > 0 ? Math.min(max, GROUP_LIMITS.membersMax) : GROUP_LIMITS.membersMax, plan };
  } catch {
    return { cap: GROUP_LIMITS.membersMax };
  }
}

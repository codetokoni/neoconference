// src/lib/groupPeople.ts
//
// Where group members come from: Clerk accounts, looked up by id or exact email.
// Server-only (Clerk backend API); the group store itself stays pure.

import { clerkClient, currentUser } from "@clerk/nextjs/server";
import type { NewMember } from "@/lib/groupStore";
import type { CreateMeetingDeps } from "@/lib/groupMeetings";
import { checkLifetimeCap, incrementMeetingsCreated } from "@/lib/plan";

type ClerkUserLike = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
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

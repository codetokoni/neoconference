// src/lib/support/admin.ts
//
// What the admin ticket desk needs beyond the ticket itself: who tickets can
// be assigned to, and the account a ticket belongs to (plan, expiry, recent
// payments and meetings). Server only.

import { clerkClient } from "@clerk/nextjs/server";
import { isOwnerEmailList, ownerEmails, verifiedEmails, type ClerkEmailish } from "@/lib/admin/owner";
import { getRole, listMembers } from "@/lib/admin/store";
import { getPlanForUserId } from "@/lib/plan";
import { listUserPayments } from "@/lib/paymentsStore";
import { eventStore } from "@/lib/eventStore";
import { meetingStartMs } from "@/lib/userMeetings";
import { applyStatus } from "@/lib/support/tickets";
import { isTicketCategory, isTicketPriority, isTicketStatus, slaFor, type SlaConfig, type Ticket } from "@/lib/support/model";

export interface Assignee {
  userId: string;
  email: string;
  name: string;
  isOwner: boolean;
}

type ClerkUserish = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  emailAddresses?: ClerkEmailish[];
  primaryEmailAddress?: { emailAddress?: string } | null;
  publicMetadata?: Record<string, unknown>;
};

function nameOf(u: ClerkUserish, email: string): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || email;
}

/**
 * Who a ticket can be assigned to: active administrators whose role can
 * answer tickets (support:write), and the platform owner's accounts.
 */
export async function listAssignees(): Promise<Assignee[]> {
  const out: Assignee[] = [];
  for (const m of await listMembers()) {
    if (m.status !== "active") continue;
    const role = await getRole(m.roleId);
    if (!role?.permissions.includes("support:write")) continue;
    out.push({ userId: m.userId, email: m.email, name: m.name, isOwner: false });
  }
  try {
    const found = await (await clerkClient()).users.getUserList({ emailAddress: ownerEmails(), limit: 10 });
    for (const u of (found.data ?? []) as ClerkUserish[]) {
      if (!isOwnerEmailList(u.emailAddresses)) continue;
      if (out.some((a) => a.userId === u.id)) continue;
      const email = verifiedEmails(u.emailAddresses).find((e) => ownerEmails().includes(e)) ?? "";
      out.unshift({ userId: u.id, email, name: nameOf(u, email), isOwner: true });
    }
  } catch (err) {
    console.error("[support] owner lookup failed", err);
  }
  return out;
}

export interface AccountSnapshot {
  found: boolean;
  userId: string | null;
  email: string;
  name: string | null;
  plan: string | null;
  planExpiresAt: number | null;
  payments: { ref: string; plan: string; amountEsp: number; status: string; paidAt: number; periodEnd: number }[];
  meetings: { id: string; slug: string; name: string; state: string; startMs: number }[];
  meetingCount: number;
  /** Where the admin area shows this account. */
  href: string;
}

/** Where the admin area shows an account. */
export function adminAccountHref(userId: string | null, email: string): string {
  return `/admin?query=${encodeURIComponent(email || userId || "")}`;
}

/** The account behind a ticket: by user id, or for a signed-out ticket by its email. */
export async function accountSnapshot(t: Pick<Ticket, "userId" | "email">): Promise<AccountSnapshot> {
  const empty: AccountSnapshot = {
    found: false,
    userId: t.userId,
    email: t.email,
    name: null,
    plan: null,
    planExpiresAt: null,
    payments: [],
    meetings: [],
    meetingCount: 0,
    href: adminAccountHref(t.userId, t.email),
  };
  let user: ClerkUserish | null = null;
  try {
    const client = await clerkClient();
    if (t.userId) user = (await client.users.getUser(t.userId)) as unknown as ClerkUserish;
    else {
      const found = await client.users.getUserList({ emailAddress: [t.email], limit: 1 });
      const u = (found.data?.[0] ?? null) as ClerkUserish | null;
      // Only an address the account has verified ties a signed-out ticket to it.
      if (u && verifiedEmails(u.emailAddresses).includes(t.email)) user = u;
    }
  } catch {
    user = null;
  }
  if (!user) return empty;

  const email = user.primaryEmailAddress?.emailAddress?.toLowerCase() || t.email;
  const expires = user.publicMetadata?.planExpiresAt;
  const [plan, payments, events] = await Promise.all([
    getPlanForUserId(user.id),
    listUserPayments(user.id, 5).catch(() => []),
    eventStore.listByOwner(user.id).catch(() => []),
  ]);
  const meetings = events
    .map((e) => ({ id: e.id, slug: e.slug, name: e.name, state: e.state, startMs: meetingStartMs(e) }))
    .sort((a, b) => b.startMs - a.startMs);
  return {
    found: true,
    userId: user.id,
    email,
    name: nameOf(user, email),
    plan,
    planExpiresAt: typeof expires === "number" ? expires : null,
    payments: payments.map((p) => ({
      ref: p.paymentRef,
      plan: p.plan,
      amountEsp: p.amountEsp,
      status: p.status,
      paidAt: p.paidAt,
      periodEnd: p.periodEnd,
    })),
    meetings: meetings.slice(0, 5),
    meetingCount: meetings.length,
    href: adminAccountHref(user.id, email),
  };
}

/** A ticket as the desk lists it. */
export function ticketRow(t: Ticket, sla: SlaConfig, now: number) {
  return { ...t, sla: slaFor(t, sla, now) };
}

export interface TicketChanges {
  status?: unknown;
  priority?: unknown;
  category?: unknown;
  /** A user id from listAssignees(), or null to unassign. */
  assigneeId?: unknown;
  tags?: unknown;
}

type Tracked = Pick<Ticket, "status" | "priority" | "category" | "assigneeId" | "assigneeEmail" | "tags">;
const tracked = (t: Ticket): Tracked => ({
  status: t.status,
  priority: t.priority,
  category: t.category,
  assigneeId: t.assigneeId,
  assigneeEmail: t.assigneeEmail,
  tags: [...t.tags],
});

export function cleanTags(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]+/gu, "").slice(0, 30))
    .filter(Boolean);
  return [...new Set(out)].slice(0, 12);
}

/**
 * Applies an administrator's changes to `t` in place (not saved). Returns the
 * fields that changed, before and after, for the audit trail — or an error
 * naming the field that was refused.
 */
export function applyTicketChanges(
  t: Ticket,
  c: TicketChanges,
  assignees: Assignee[],
  now: number,
): { ok: true; before: Partial<Tracked>; after: Partial<Tracked> } | { ok: false; error: string; message: string } {
  const before = tracked(t);
  if (c.status !== undefined) {
    if (!isTicketStatus(c.status)) return { ok: false, error: "invalid_status", message: "Unknown status." };
    applyStatus(t, c.status, now);
  }
  if (c.priority !== undefined) {
    if (!isTicketPriority(c.priority)) return { ok: false, error: "invalid_priority", message: "Unknown priority." };
    t.priority = c.priority;
  }
  if (c.category !== undefined) {
    if (!isTicketCategory(c.category)) return { ok: false, error: "invalid_category", message: "Unknown category." };
    t.category = c.category;
  }
  if (c.assigneeId !== undefined) {
    if (c.assigneeId === null || c.assigneeId === "") {
      t.assigneeId = null;
      t.assigneeEmail = null;
    } else {
      const a = assignees.find((x) => x.userId === c.assigneeId);
      if (!a) return { ok: false, error: "invalid_assignee", message: "Tickets can be assigned to an administrator who can answer them, or the owner." };
      t.assigneeId = a.userId;
      t.assigneeEmail = a.email;
    }
  }
  if (c.tags !== undefined) {
    const tags = cleanTags(c.tags);
    if (!tags) return { ok: false, error: "invalid_tags", message: "Tags are a list of words." };
    t.tags = tags;
  }
  const after = tracked(t);
  const b: Partial<Tracked> = {};
  const a: Partial<Tracked> = {};
  for (const k of Object.keys(before) as (keyof Tracked)[]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      (b as Record<string, unknown>)[k] = before[k];
      (a as Record<string, unknown>)[k] = after[k];
    }
  }
  if (Object.keys(a).length) t.updatedAt = now;
  return { ok: true, before: b, after: a };
}

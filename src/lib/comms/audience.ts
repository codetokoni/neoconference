// src/lib/comms/audience.ts
//
// Who an announcement goes to. An audience is one of:
//
//   everyone   every account
//   filter     accounts matching plan / account status / sign-up date
//   groups     the members of one or more groups (by group id)
//   users      specific people, by user id or email
//
// and, except for "everyone", the plan / status / sign-up filters narrow
// the result. Resolution pages through Clerk (500 accounts a page for
// everyone/filter, 100 ids a request for groups/users), so a send of any
// size is resolved a page at a time by the send job, never in one request.
//
// Groups are named by id: the admin screen finds them in the platform-wide
// group index (/api/admin/comms/groups → src/lib/admin/groups.ts). Members
// come from groupStore.listMembers(); people added by email who have no
// account yet (pending members) have nowhere to receive a notice.

import { clerkClient } from "@clerk/nextjs/server";
import { isPlan, readPlanFromMetadata, type Plan } from "@/lib/planLimits";
import { isOwnerEmailList, type ClerkEmailish } from "@/lib/admin/owner";
import { getGroup, listMembers } from "@/lib/groupStore";

export const ACCOUNT_STATUSES = ["active", "suspended", "locked"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export type AudienceKind = "everyone" | "filter" | "groups" | "users";

export interface Audience {
  kind: AudienceKind;
  plans?: Plan[];
  statuses?: AccountStatus[];
  /** Epoch ms, inclusive. */
  signedUpFrom?: number;
  signedUpTo?: number;
  groupIds?: string[];
  /** User ids (user_…) or email addresses. */
  users?: string[];
}

export interface Recipient {
  uid: string;
  email: string;
  name: string;
  firstName: string;
  plan: Plan;
  status: AccountStatus;
  createdAt: number;
}

const PAGE = 500;
const ID_PAGE = 100;

export function cleanAudience(raw: unknown): { audience: Audience } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Choose who the message goes to." };
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (kind !== "everyone" && kind !== "filter" && kind !== "groups" && kind !== "users") return { error: "Choose who the message goes to." };
  const a: Audience = { kind };
  if (kind === "everyone") return { audience: a };
  const list = (v: unknown, max: number) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))].slice(0, max) : [];
  const plans = list(r.plans, 10).filter(isPlan);
  if (plans.length) a.plans = plans;
  const statuses = list(r.statuses, 5).filter((s): s is AccountStatus => (ACCOUNT_STATUSES as readonly string[]).includes(s));
  if (statuses.length) a.statuses = statuses;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v ? Date.parse(v) : NaN);
  const from = num(r.signedUpFrom);
  const to = num(r.signedUpTo);
  if (Number.isFinite(from)) a.signedUpFrom = from;
  if (Number.isFinite(to)) a.signedUpTo = to;
  if (a.signedUpFrom && a.signedUpTo && a.signedUpFrom > a.signedUpTo) return { error: "The sign-up range ends before it starts." };
  if (kind === "groups") {
    a.groupIds = list(r.groupIds, 50);
    if (!a.groupIds.length) return { error: "Add at least one group id." };
  }
  if (kind === "users") {
    a.users = list(r.users, 2000).map((u) => (u.includes("@") ? u.toLowerCase() : u));
    if (!a.users.length) return { error: "Add at least one user id or email." };
  }
  if (kind === "filter" && !a.plans && !a.statuses && a.signedUpFrom == null && a.signedUpTo == null) {
    return { error: "Pick at least one filter, or choose Everyone." };
  }
  return { audience: a };
}

/** One line for history and the audit log. */
export function describeAudience(a: Audience): string {
  const parts: string[] = [];
  if (a.kind === "everyone") return "Everyone";
  if (a.kind === "groups") parts.push(`Members of ${a.groupIds!.length} group${a.groupIds!.length === 1 ? "" : "s"}`);
  if (a.kind === "users") parts.push(`${a.users!.length} named ${a.users!.length === 1 ? "person" : "people"}`);
  if (a.plans) parts.push(`plan ${a.plans.join(" or ")}`);
  if (a.statuses) parts.push(`status ${a.statuses.join(" or ")}`);
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (a.signedUpFrom != null && a.signedUpTo != null) parts.push(`signed up ${d(a.signedUpFrom)} to ${d(a.signedUpTo)}`);
  else if (a.signedUpFrom != null) parts.push(`signed up from ${d(a.signedUpFrom)}`);
  else if (a.signedUpTo != null) parts.push(`signed up until ${d(a.signedUpTo)}`);
  return parts.join(", ");
}

type ClerkUser = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  emailAddresses?: ClerkEmailish[];
  primaryEmailAddress?: { emailAddress?: string } | null;
  publicMetadata?: Record<string, unknown> | null;
  createdAt?: number;
  banned?: boolean;
  locked?: boolean;
};

export function statusOf(u: ClerkUser): AccountStatus {
  // Admin → Users suspends with Clerk's ban (a pending deletion is banned
  // too); "locked" is Clerk's own lockout after failed sign-ins.
  if (u.banned) return "suspended";
  if (u.locked) return "locked";
  return "active";
}

export function toRecipient(u: ClerkUser): Recipient {
  const email = (u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || "").trim().toLowerCase();
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || email || u.id;
  return {
    uid: u.id,
    email,
    name,
    firstName: u.firstName || "",
    plan: isOwnerEmailList(u.emailAddresses) ? "enterprise" : readPlanFromMetadata(u.publicMetadata),
    status: statusOf(u),
    createdAt: typeof u.createdAt === "number" ? u.createdAt : 0,
  };
}

export function matches(a: Audience, r: Recipient): boolean {
  if (a.kind === "everyone") return true;
  if (a.plans && !a.plans.includes(r.plan)) return false;
  if (a.statuses && !a.statuses.includes(r.status)) return false;
  if (a.signedUpFrom != null && r.createdAt < a.signedUpFrom) return false;
  if (a.signedUpTo != null && r.createdAt > a.signedUpTo) return false;
  return true;
}

/** The user ids and emails a groups/users audience names, before Clerk. */
async function namedIds(a: Audience): Promise<{ ids: string[]; emails: string[]; unmatchedGroups: string[] }> {
  if (a.kind === "users") {
    const users = a.users ?? [];
    return { ids: users.filter((u) => !u.includes("@")), emails: users.filter((u) => u.includes("@")), unmatchedGroups: [] };
  }
  const ids = new Set<string>();
  const unmatchedGroups: string[] = [];
  for (const gid of a.groupIds ?? []) {
    const group = await getGroup(gid);
    if (!group) {
      unmatchedGroups.push(gid);
      continue;
    }
    for (const m of await listMembers(gid)) ids.add(m.userId);
  }
  return { ids: [...ids], emails: [], unmatchedGroups };
}

export interface AudiencePage {
  recipients: Recipient[];
  /** Pass back for the next page; null when done. */
  next: number | null;
  /** Accounts looked at on this page (before filters). */
  scanned: number;
  /** Total accounts Clerk has, when it said (everyone/filter). */
  total?: number;
  /** Names that matched nobody (users / groups). */
  unmatched?: string[];
}

/** One page of recipients, starting at `cursor` (0 for the first page). */
export async function resolvePage(a: Audience, cursor: number): Promise<AudiencePage> {
  const client = await clerkClient();
  if (a.kind === "everyone" || a.kind === "filter") {
    const res = (await client.users.getUserList({ limit: PAGE, offset: cursor, orderBy: "-created_at" } as never)) as unknown as {
      data: ClerkUser[];
      totalCount: number;
    };
    const recipients = res.data.map(toRecipient).filter((r) => matches(a, r));
    const done = res.data.length < PAGE || cursor + res.data.length >= res.totalCount;
    return { recipients, next: done ? null : cursor + res.data.length, scanned: res.data.length, total: res.totalCount };
  }
  // Named ids and emails, in pages of ID_PAGE: ids first, then emails.
  const { ids, emails, unmatchedGroups } = await namedIds(a);
  const all = [...ids.map((v) => ({ id: v })), ...emails.map((v) => ({ email: v }))];
  const slice = all.slice(cursor, cursor + ID_PAGE);
  const sliceIds = slice.filter((s): s is { id: string } => "id" in s).map((s) => s.id);
  const sliceEmails = slice.filter((s): s is { email: string } => "email" in s).map((s) => s.email);
  const found: ClerkUser[] = [];
  if (sliceIds.length) {
    const res = (await client.users.getUserList({ userId: sliceIds, limit: ID_PAGE } as never)) as unknown as { data: ClerkUser[] };
    found.push(...res.data);
  }
  if (sliceEmails.length) {
    const res = (await client.users.getUserList({ emailAddress: sliceEmails, limit: ID_PAGE } as never)) as unknown as { data: ClerkUser[] };
    found.push(...res.data);
  }
  const seen = new Set<string>();
  const recipients = found
    .filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)))
    .map(toRecipient)
    .filter((r) => matches(a, r));
  const unmatched = [
    ...(cursor === 0 ? unmatchedGroups.map((g) => `group ${g}`) : []),
    ...sliceIds.filter((id) => !found.some((u) => u.id === id)),
    ...sliceEmails.filter((e) => !found.some((u) => (u.emailAddresses ?? []).some((x) => x.emailAddress.toLowerCase() === e))),
  ];
  const next = cursor + ID_PAGE < all.length ? cursor + ID_PAGE : null;
  return { recipients, next, scanned: slice.length, ...(unmatched.length ? { unmatched } : {}) };
}

export interface AudiencePreview {
  count: number;
  /** False when the preview stopped before the end (a very large audience). */
  exact: boolean;
  sample: Array<Pick<Recipient, "uid" | "email" | "name" | "plan" | "status">>;
  withEmail: number;
  unmatched: string[];
  groups: Array<{ id: string; name: string } | { id: string; missing: true }>;
}

/** Count and sample an audience. Stops after `maxPages` pages and says so. */
export async function previewAudience(a: Audience, maxPages = 40): Promise<AudiencePreview> {
  let cursor: number | null = 0;
  let count = 0;
  let withEmail = 0;
  const sample: AudiencePreview["sample"] = [];
  const unmatched: string[] = [];
  let pages = 0;
  if (a.kind === "everyone") {
    const first = await resolvePage(a, 0);
    for (const r of first.recipients.slice(0, 10)) sample.push({ uid: r.uid, email: r.email, name: r.name, plan: r.plan, status: r.status });
    // Everyone has an address in Clerk unless they signed up by phone or KingsChat only.
    const share = first.recipients.length ? first.recipients.filter((r) => r.email).length / first.recipients.length : 1;
    const total = first.total ?? first.recipients.length;
    return { count: total, exact: true, sample, withEmail: Math.round(total * share), unmatched, groups: [] };
  }
  while (cursor !== null && pages < maxPages) {
    const page: AudiencePage = await resolvePage(a, cursor);
    pages++;
    count += page.recipients.length;
    withEmail += page.recipients.filter((r) => r.email).length;
    if (page.unmatched) unmatched.push(...page.unmatched);
    for (const r of page.recipients) {
      if (sample.length >= 10) break;
      sample.push({ uid: r.uid, email: r.email, name: r.name, plan: r.plan, status: r.status });
    }
    cursor = page.next;
  }
  const groups: AudiencePreview["groups"] = [];
  for (const id of a.kind === "groups" ? a.groupIds ?? [] : []) {
    const g = await getGroup(id);
    groups.push(g ? { id, name: g.name } : { id, missing: true });
  }
  return { count, exact: cursor === null, sample, withEmail, unmatched, groups };
}

// src/lib/admin/users.ts
//
// What the admin area keeps about a user account, beside what Clerk keeps:
//
//   neo:admin:user-tags            hash  userId -> JSON string[]
//   neo:admin:user:<uid>:notes     list  JSON UserNote, newest first (capped)
//   neo:admin:deletions            hash  userId -> JSON PendingDeletion
//   neo:admin:suspensions          hash  userId -> JSON Suspension (why, by whom; Clerk's ban has no reason)
//   neo:admin:support:<adminId>    JSON  the administrator's open SupportSession (TTL)
//   neo:admin:user:<uid>:support   list  JSON SupportSession, newest first (capped)
//
// And the one rule every user action goes through, targetGuard(): nobody
// acts on the platform owner, on themselves, or on an administrator whose
// role holds permissions they do not.

import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import { readRoleFromMetadata, isAdmin as isEnvAdmin } from "@/lib/roles";
import { readPlanFromMetadata, isPlan, type Plan } from "@/lib/planLimits";
import { isOwnerEmailList, verifiedEmails, type ClerkEmailish } from "@/lib/admin/owner";
import { getMember, getRole, type AdminMember } from "@/lib/admin/store";
import { getActiveSessions, logout } from "@/lib/sessionStore";
import { beyondActor, fail } from "@/lib/admin/http";
import type { AdminContext } from "@/lib/admin/context";
import type { NextResponse } from "next/server";

const TAGS = "neo:admin:user-tags";
const DELETIONS = "neo:admin:deletions";
const SUSPENSIONS = "neo:admin:suspensions";
const notesKey = (uid: string) => `neo:admin:user:${uid}:notes`;
const supportKey = (adminId: string) => `neo:admin:support:${adminId}`;
const supportHistoryKey = (uid: string) => `neo:admin:user:${uid}:support`;

/**
 * How long a deleted account waits before it can be removed for good — the
 * default. The period in force is the "Deleted accounts" retention setting
 * (src/lib/dataGov/settings.ts), which new requests read.
 */
export const DELETION_RETENTION_DAYS = 30;
export const DELETION_RETENTION_MS = DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const NOTES_MAX = 200;
export const TAGS_MAX = 20;
export const SUPPORT_MINUTES = { min: 5, max: 120, default: 30 };

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

/* ------------------------------- Clerk user ------------------------------- */

/** The parts of Clerk's backend User the admin area reads. */
export interface ClerkUserish {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  imageUrl?: string;
  publicMetadata?: Record<string, unknown> | null;
  emailAddresses?: (ClerkEmailish & { id?: string })[];
  primaryEmailAddressId?: string | null;
  primaryEmailAddress?: { emailAddress?: string } | null;
  banned?: boolean;
  locked?: boolean;
  createdAt?: number;
  lastSignInAt?: number | null;
  lastActiveAt?: number | null;
  passwordEnabled?: boolean;
  twoFactorEnabled?: boolean;
}

export function displayName(u: ClerkUserish): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "";
}

export function primaryEmail(u: ClerkUserish): string {
  const list = u.emailAddresses ?? [];
  const primary = list.find((e) => e.id && e.id === u.primaryEmailAddressId);
  return (primary?.emailAddress || u.primaryEmailAddress?.emailAddress || list[0]?.emailAddress || "").toLowerCase();
}

export function isOwnerUser(u: ClerkUserish): boolean {
  return isOwnerEmailList(u.emailAddresses);
}

/** The plan the app applies: owner and ADMIN_EMAILS operators get the top tier (src/lib/plan.ts). */
export function effectivePlan(u: ClerkUserish): Plan {
  if (isOwnerUser(u)) return "enterprise";
  const stored = readPlanFromMetadata(u.publicMetadata);
  if (stored !== "free") return stored;
  if (verifiedEmails(u.emailAddresses).some((e) => isEnvAdmin(e))) return "enterprise";
  return stored;
}

export function storedPlan(u: ClerkUserish): { plan: Plan | null; planExpiresAt: number | null } {
  const m = (u.publicMetadata ?? {}) as Record<string, unknown>;
  return {
    plan: isPlan(m.plan) ? m.plan : null,
    planExpiresAt: typeof m.planExpiresAt === "number" ? m.planExpiresAt : null,
  };
}

export type Access = "owner" | "admin" | "admin (suspended)" | null;

export function accessOf(u: ClerkUserish, member: AdminMember | undefined | null): Access {
  if (isOwnerUser(u)) return "owner";
  if (member && member.status !== "removed") return member.status === "suspended" ? "admin (suspended)" : "admin";
  return null;
}

/** One row of the Users list. */
export function summarize(
  u: ClerkUserish,
  extra: { member?: AdminMember | null; tags?: string[]; deletion?: PendingDeletion | null },
) {
  const email = primaryEmail(u);
  const list = u.emailAddresses ?? [];
  const primary = list.find((e) => e.emailAddress.toLowerCase() === email);
  const { plan, planExpiresAt } = storedPlan(u);
  return {
    id: u.id,
    name: displayName(u),
    email,
    emailVerified: primary?.verification?.status === "verified",
    imageUrl: u.imageUrl ?? "",
    plan: effectivePlan(u),
    storedPlan: plan,
    planExpiresAt,
    appRole: readRoleFromMetadata(u.publicMetadata),
    access: accessOf(u, extra.member),
    banned: !!u.banned,
    locked: !!u.locked,
    createdAt: u.createdAt ?? null,
    lastSignInAt: u.lastSignInAt ?? null,
    lastActiveAt: u.lastActiveAt ?? null,
    tags: extra.tags ?? [],
    pendingDeletion: extra.deletion ?? null,
  };
}

export type UserRow = ReturnType<typeof summarize>;

/* --------------------------------- guard ---------------------------------- */

/** The account behind a route's [id], with its administrator record if it has one. */
export async function loadTargetUser(
  id: string,
): Promise<{ user: ClerkUserish; member: AdminMember | null } | { response: NextResponse }> {
  const userId = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(userId)) return { response: fail("not_found", "No such user.", 404) };
  let user: ClerkUserish;
  try {
    const client = await clerkClient();
    user = (await client.users.getUser(userId)) as unknown as ClerkUserish;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status && status !== 404) throw err;
    return { response: fail("not_found", "No such user.", 404) };
  }
  return { user, member: await getMember(userId) };
}

/**
 * Whether `ctx` may act on account `u`. The owner is refused first and
 * always: no permission, role or flag reaches them from here.
 */
export async function targetGuard(
  ctx: AdminContext,
  u: ClerkUserish,
  member: AdminMember | null,
): Promise<NextResponse | null> {
  if (isOwnerUser(u)) return fail("owner_protected", "The platform owner's account cannot be changed from the admin area.", 403);
  if (u.id === ctx.userId) return fail("not_on_yourself", "You cannot do this to your own account here.", 400);
  if (member && member.status !== "removed") {
    const role = await getRole(member.roleId);
    const over = beyondActor(ctx, role?.permissions ?? []);
    if (over.length) {
      return fail("outranks_you", "This administrator's role has permissions you do not, so only the owner can act on their account.", 403, {
        permissions: over,
      });
    }
  }
  return null;
}

/* ---------------------------------- tags ---------------------------------- */

export function cleanTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const t of input) {
    if (typeof t !== "string") continue;
    const tag = t.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 32);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, TAGS_MAX);
}

export async function getTags(uid: string): Promise<string[]> {
  return parse<string[]>(await kv.hget(TAGS, uid)) ?? [];
}

export async function allTags(): Promise<Map<string, string[]>> {
  const all = ((await kv.hgetall(TAGS)) ?? {}) as Record<string, unknown>;
  const out = new Map<string, string[]>();
  for (const [uid, v] of Object.entries(all)) {
    const tags = parse<string[]>(v);
    if (tags?.length) out.set(uid, tags);
  }
  return out;
}

export async function setTags(uid: string, tags: string[]): Promise<void> {
  if (tags.length) await kv.hset(TAGS, { [uid]: JSON.stringify(tags) });
  else await kv.hdel(TAGS, uid);
}

/* ---------------------------------- notes --------------------------------- */

export interface UserNote {
  id: string;
  ts: number;
  byId: string;
  byEmail: string;
  text: string;
}

export async function listNotes(uid: string): Promise<UserNote[]> {
  const raw = ((await kv.lrange(notesKey(uid), 0, NOTES_MAX - 1)) ?? []) as unknown[];
  return raw.map((r) => parse<UserNote>(r)).filter((n): n is UserNote => !!n);
}

export async function addNote(uid: string, note: Omit<UserNote, "id" | "ts">): Promise<UserNote> {
  const full: UserNote = { id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(), ...note };
  await kv.lpush(notesKey(uid), JSON.stringify(full));
  await kv.ltrim(notesKey(uid), 0, NOTES_MAX - 1);
  return full;
}

/** Remove one note; returns it, or null if there was none with that id. */
export async function removeNote(uid: string, noteId: string): Promise<UserNote | null> {
  const notes = await listNotes(uid);
  const gone = notes.find((n) => n.id === noteId) ?? null;
  if (!gone) return null;
  await kv.del(notesKey(uid));
  const keep = notes.filter((n) => n.id !== noteId);
  // lpush puts each value first, so push oldest first to keep the order.
  for (const n of [...keep].reverse()) await kv.lpush(notesKey(uid), JSON.stringify(n));
  return gone;
}

/* ------------------------- suspension and sign-out ------------------------ */

export interface Suspension {
  at: number;
  byId: string;
  byEmail: string;
  reason: string;
}

export async function getSuspension(uid: string): Promise<Suspension | null> {
  return parse<Suspension>(await kv.hget(SUSPENSIONS, uid));
}

export async function setSuspension(uid: string, s: Suspension | null): Promise<void> {
  if (s) await kv.hset(SUSPENSIONS, { [uid]: JSON.stringify(s) });
  else await kv.hdel(SUSPENSIONS, uid);
}

/**
 * End every session the account has: Clerk's (the browser sign-ins) and the
 * app's own device sessions (src/lib/sessionStore.ts). Returns how many of
 * each were open.
 *
 * `first` runs after the sessions are counted and before they are revoked:
 * a ban, or marking the password compromised, ends Clerk's sessions itself,
 * so counting afterwards would report none.
 */
export async function signOutEverywhere(uid: string, first?: () => Promise<unknown>): Promise<{ clerk: number; devices: number }> {
  const client = await clerkClient();
  const list = await client.sessions.getSessionList({ userId: uid, status: "active", limit: 100 });
  if (first) await first();
  for (const s of list.data) {
    try {
      await client.sessions.revokeSession(s.id);
    } catch (err) {
      // `first` may already have ended it.
      if (!first) throw err;
    }
  }
  const devices = (await getActiveSessions(uid)).length;
  await logout(uid, null, "all");
  return { clerk: list.data.length, devices };
}

/* -------------------------------- deletion -------------------------------- */

export interface PendingDeletion {
  requestedAt: number;
  /** Earliest moment "Delete now" may remove the account for good. */
  deleteAfter: number;
  requestedById: string;
  requestedByEmail: string;
  reason: string;
  /** Whether the account was already suspended, so cancelling does not lift a separate suspension. */
  wasBanned: boolean;
}

export async function getDeletion(uid: string): Promise<PendingDeletion | null> {
  return parse<PendingDeletion>(await kv.hget(DELETIONS, uid));
}

export async function allDeletions(): Promise<Map<string, PendingDeletion>> {
  const all = ((await kv.hgetall(DELETIONS)) ?? {}) as Record<string, unknown>;
  const out = new Map<string, PendingDeletion>();
  for (const [uid, v] of Object.entries(all)) {
    const d = parse<PendingDeletion>(v);
    if (d) out.set(uid, d);
  }
  return out;
}

export async function setDeletion(uid: string, d: PendingDeletion): Promise<void> {
  await kv.hset(DELETIONS, { [uid]: JSON.stringify(d) });
}

export async function clearDeletion(uid: string): Promise<void> {
  await kv.hdel(DELETIONS, uid);
}

/** After an account is removed for good: what the admin area kept about it (the audit trail stays). */
export async function forgetUser(uid: string): Promise<void> {
  await kv.hdel(TAGS, uid);
  await kv.hdel(DELETIONS, uid);
  await kv.hdel(SUSPENSIONS, uid);
  await kv.del(notesKey(uid));
}

/* ----------------------------- support sessions --------------------------- */

export interface SupportSession {
  id: string;
  adminId: string;
  adminEmail: string;
  userId: string;
  userEmail: string;
  userName: string;
  reason: string;
  startedAt: number;
  expiresAt: number;
  endedAt?: number;
  endedBy?: "admin" | "expired" | "replaced";
}

export function supportOpen(s: SupportSession | null | undefined, now = Date.now()): s is SupportSession {
  return !!s && !s.endedAt && s.expiresAt > now;
}

/** The administrator's open support session, if any (one at a time). */
export async function activeSupportSession(adminId: string): Promise<SupportSession | null> {
  const s = parse<SupportSession>(await kv.get(supportKey(adminId)));
  return supportOpen(s) ? s : null;
}

export async function listSupportSessions(uid: string, limit = 20): Promise<SupportSession[]> {
  const raw = ((await kv.lrange(supportHistoryKey(uid), 0, limit - 1)) ?? []) as unknown[];
  return raw.map((r) => parse<SupportSession>(r)).filter((s): s is SupportSession => !!s);
}

async function writeHistory(s: SupportSession): Promise<void> {
  // The history keeps the latest state of each session: replace by id.
  const list = await listSupportSessions(s.userId, 50);
  const next = [s, ...list.filter((x) => x.id !== s.id)].slice(0, 50);
  await kv.del(supportHistoryKey(s.userId));
  for (const x of [...next].reverse()) await kv.lpush(supportHistoryKey(s.userId), JSON.stringify(x));
}

export async function startSupportSession(
  input: Omit<SupportSession, "id" | "startedAt" | "expiresAt" | "endedAt" | "endedBy"> & { minutes: number },
): Promise<{ session: SupportSession; replaced: SupportSession | null }> {
  const replaced = await activeSupportSession(input.adminId);
  if (replaced) await endSupportSession(input.adminId, "replaced");
  const now = Date.now();
  const { minutes, ...rest } = input;
  const session: SupportSession = {
    id: `sup_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ...rest,
    startedAt: now,
    expiresAt: now + minutes * 60_000,
  };
  await kv.set(supportKey(input.adminId), JSON.stringify(session), { ex: minutes * 60 + 60 });
  await writeHistory(session);
  return { session, replaced };
}

export async function endSupportSession(adminId: string, by: "admin" | "replaced" = "admin"): Promise<SupportSession | null> {
  const s = await activeSupportSession(adminId);
  if (!s) return null;
  const ended: SupportSession = { ...s, endedAt: Date.now(), endedBy: by };
  await kv.del(supportKey(adminId));
  await writeHistory(ended);
  return ended;
}

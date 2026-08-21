// src/lib/meeting-roles.ts
//
// Membership and role assignment for a meeting. This is the WRITE half of the
// RBAC system; src/lib/permissions.ts is the read/decision half and this module
// defers to it for every ordering question — there is no rank logic here.
//
// Storage
//   neo:meeting:<eventId>:roles   Redis hash
//     field  = Clerk userId, or a lowercased email (the same identity keys
//              NeoEvent.roles[] matches on, so invites sent before a person has
//              an account keep working)
//     value  = { role, assignedAt, assignedBy }
//
// The owner is never in the hash — ownership lives on NeoEvent.ownerUserId and
// is not revocable through this API. getMeetingParticipants() merges them in.
//
// Why a hash rather than the NeoEvent.roles[] array: every write to the array
// is a read-modify-write of the whole event JSON, so two concurrent promotions
// silently clobber each other. HSET/HDEL touch one field. The array is still
// read as a migration fallback and logs a deprecation warning when it is hit.
//
// Pure module: no Clerk, no Next, no HTTP. Safe to call from a route handler,
// a cron job, or a test.

import { kv } from "@vercel/kv";
import { RANK, canManageRole, isMeetingRole, normalizeRole, type Actor, type MeetingRole } from "@/lib/permissions";
import type { NeoEvent } from "@/types/event";

/* -------------------------------------------------------------------------- */
/*  Keys and storage                                                           */
/* -------------------------------------------------------------------------- */

/** Redis key holding every non-owner role assignment for one event. */
export function meetingRolesKey(eventId: string): string {
  return `neo:meeting:${eventId}:roles`;
}

export interface RoleAssignmentEntry {
  role: MeetingRole;
  /** Epoch ms. */
  assignedAt: number;
  /** Clerk userId of whoever granted it, or null for system/migrated rows. */
  assignedBy: string | null;
}

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// In-process fallback so the app (and tests) still run without KV, mirroring
// the pattern in eventStore.ts. NOT durable across lambdas or deploys.
const memRoles = new Map<string, Map<string, RoleAssignmentEntry>>();

function memBucket(eventId: string): Map<string, RoleAssignmentEntry> {
  let b = memRoles.get(eventId);
  if (!b) {
    b = new Map();
    memRoles.set(eventId, b);
  }
  return b;
}

let warnedKv = false;
function warnKvOnce(): void {
  if (warnedKv) return;
  warnedKv = true;
  console.warn(
    "[neo:meeting-roles] Vercel KV is not configured (KV_REST_API_URL / KV_REST_API_TOKEN missing). " +
      "Falling back to in-memory storage. Role assignments will NOT survive restarts."
  );
}

let warnedFallback = false;
function warnLegacyOnce(eventId: string): void {
  if (warnedFallback) return;
  warnedFallback = true;
  console.warn(
    `[neo:meeting-roles] DEPRECATED: read a role from NeoEvent.roles[] (event ${eventId}). ` +
      "Re-save it through assignMeetingRole() so it moves to the hash; the array fallback will be removed."
  );
}

/** @vercel/kv round-trips JSON, but a hand-written field may arrive as a string. */
function parseEntry(raw: unknown): RoleAssignmentEntry | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      // A bare role string (e.g. "moderator") written by an older path.
      return isMeetingRole(raw) ? { role: raw, assignedAt: 0, assignedBy: null } : null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const r = (obj as { role?: unknown }).role;
  if (!isMeetingRole(r)) return null;
  const at = (obj as { assignedAt?: unknown }).assignedAt;
  const by = (obj as { assignedBy?: unknown }).assignedBy;
  return {
    role: r,
    assignedAt: typeof at === "number" && Number.isFinite(at) ? at : 0,
    assignedBy: typeof by === "string" && by.length > 0 ? by : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Identity                                                                   */
/* -------------------------------------------------------------------------- */

/** Anything callers might have in hand: a raw id/email, an Actor, or both. */
export type UserIdentity = string | { userId?: string | null; emails?: string[] | null };

interface ResolvedIdentity {
  userId: string | null;
  emails: string[];
  /** Every hash field this person could be stored under, deduped. */
  keys: string[];
}

function looksLikeEmail(s: string): boolean {
  return s.includes("@");
}

/**
 * Normalises the identity forms into hash fields. Emails are lowercased;
 * userIds keep their case (Clerk ids are case-sensitive).
 */
export function resolveIdentity(identity: UserIdentity): ResolvedIdentity {
  let userId: string | null = null;
  let emails: string[] = [];

  if (typeof identity === "string") {
    const v = identity.trim();
    if (looksLikeEmail(v)) emails = [v.toLowerCase()];
    else if (v) userId = v;
  } else if (identity && typeof identity === "object") {
    userId = (identity.userId || "").trim() || null;
    emails = (identity.emails || [])
      .map((e) => (e || "").trim().toLowerCase())
      .filter((e) => e.length > 0);
  }

  const keys: string[] = [];
  if (userId) keys.push(userId);
  for (const e of emails) if (!keys.includes(e)) keys.push(e);
  return { userId, emails, keys };
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                      */
/* -------------------------------------------------------------------------- */

async function hgetField(eventId: string, field: string): Promise<RoleAssignmentEntry | null> {
  if (!isKvConfigured()) {
    warnKvOnce();
    return memBucket(eventId).get(field) ?? null;
  }
  try {
    const raw = await kv.hget(meetingRolesKey(eventId), field);
    return parseEntry(raw);
  } catch (err) {
    console.error(`[neo:meeting-roles] hget failed (event ${eventId}, field ${field})`, err);
    return null;
  }
}

/**
 * Migration fallback: the pre-hash home for role assignments. Loaded lazily so
 * this module has no static dependency on eventStore (and no import cycle).
 */
async function legacyRoleFor(eventId: string, keys: string[]): Promise<MeetingRole | null> {
  if (keys.length === 0) return null;
  try {
    const { eventStore } = await import("@/lib/eventStore");
    const ev = await eventStore.byId(eventId);
    if (!ev) return null;
    const lowered = keys.map((k) => k.toLowerCase());
    let best: MeetingRole | null = null;
    for (const a of ev.roles || []) {
      const id = (a.identifier || "").trim().toLowerCase();
      if (!id || !lowered.includes(id)) continue;
      const mapped = normalizeRole(a.role);
      if (best === null || RANK[mapped] > RANK[best]) best = mapped;
    }
    if (best) warnLegacyOnce(eventId);
    return best;
  } catch (err) {
    console.error(`[neo:meeting-roles] legacy roles[] lookup failed (event ${eventId})`, err);
    return null;
  }
}

/**
 * One user's assigned role for a meeting, or null if they hold no assignment.
 *
 * null does NOT mean "may not join" — it means "no elevated role". An ordinary
 * attendee has no row here. Use getMeetingParticipants() for the member list.
 */
export async function getMeetingRole(eventId: string, userId: string): Promise<MeetingRole | null> {
  if (!eventId || !userId) return null;
  const entry = await hgetField(eventId, userId);
  if (entry) return entry.role;
  return legacyRoleFor(eventId, [userId]);
}

/** Role by email — the invite path, before the person has a Clerk account. */
export async function getMeetingRoleByEmail(eventId: string, email: string): Promise<MeetingRole | null> {
  if (!eventId || !email) return null;
  const field = email.trim().toLowerCase();
  if (!field) return null;
  const entry = await hgetField(eventId, field);
  if (entry) return entry.role;
  return legacyRoleFor(eventId, [field]);
}

/** Highest role held under any of this identity's keys. */
async function highestRoleFor(eventId: string, id: ResolvedIdentity): Promise<MeetingRole | null> {
  let best: MeetingRole | null = null;
  for (const key of id.keys) {
    const entry = await hgetField(eventId, key);
    if (entry && (best === null || RANK[entry.role] > RANK[best])) best = entry.role;
  }
  if (best) return best;
  return legacyRoleFor(eventId, id.keys);
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                     */
/* -------------------------------------------------------------------------- */

export class MeetingRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingRoleError";
  }
}

/**
 * Grant a role. The rank guard is the point of this function: `canManageRole`
 * refuses anything at or above the actor's own rank, so a moderator cannot mint
 * moderators and nobody can touch the owner.
 *
 * Writes one field per identity key, so a person invited by email and later
 * signed in under a Clerk id resolves the same either way.
 *
 * @throws MeetingRoleError  event_not_found | empty_identity | cannot_manage_self
 *                           | cannot_target_owner | insufficient_rank | write_failed
 */
export async function assignMeetingRole(
  eventId: string,
  userIdentity: UserIdentity,
  newRole: MeetingRole,
  actor: Actor
): Promise<void> {
  if (!eventId) throw new MeetingRoleError("event_not_found");
  if (!isMeetingRole(newRole)) throw new MeetingRoleError("invalid_role");

  const target = resolveIdentity(userIdentity);
  if (target.keys.length === 0) throw new MeetingRoleError("empty_identity");

  const { eventStore } = await import("@/lib/eventStore");
  const event = await eventStore.byId(eventId);
  if (!event) throw new MeetingRoleError("event_not_found");

  // Ownership is not grantable or transferable through this API.
  const ownerId = (event.ownerUserId || "").toLowerCase();
  const ownerEmail = (event.ownerEmail || "").toLowerCase();
  const targetIsOwner =
    (!!ownerId && target.keys.some((k) => k.toLowerCase() === ownerId)) ||
    (!!ownerEmail && target.emails.includes(ownerEmail));
  if (targetIsOwner) throw new MeetingRoleError("cannot_target_owner");
  if (newRole === "owner") throw new MeetingRoleError("cannot_assign_owner");

  // Self-promotion is the classic escalation; block it before the rank check
  // so the error is specific.
  if (actor.userId && target.userId && actor.userId === target.userId) {
    throw new MeetingRoleError("cannot_manage_self");
  }
  if (actor.userId && target.emails.some((e) => actor.emails.includes(e))) {
    throw new MeetingRoleError("cannot_manage_self");
  }

  if (!canManageRole(actor, newRole, false)) throw new MeetingRoleError("insufficient_rank");

  const entry: RoleAssignmentEntry = {
    role: newRole,
    assignedAt: Date.now(),
    assignedBy: actor.userId ?? null,
  };

  if (!isKvConfigured()) {
    warnKvOnce();
    const bucket = memBucket(eventId);
    for (const key of target.keys) bucket.set(key, entry);
    return;
  }

  try {
    const fields: Record<string, RoleAssignmentEntry> = {};
    for (const key of target.keys) fields[key] = entry;
    await kv.hset(meetingRolesKey(eventId), fields);
  } catch (err) {
    console.error(`[neo:meeting-roles] hset failed (event ${eventId})`, err);
    throw new MeetingRoleError("write_failed");
  }
}

/**
 * Drop every assignment for an identity. Never throws for an absent row —
 * removing a role nobody holds is a no-op, not an error.
 */
export async function removeMeetingRole(eventId: string, userIdentity: UserIdentity): Promise<void> {
  if (!eventId) return;
  const target = resolveIdentity(userIdentity);
  if (target.keys.length === 0) return;

  if (!isKvConfigured()) {
    warnKvOnce();
    const bucket = memBucket(eventId);
    for (const key of target.keys) bucket.delete(key);
    return;
  }

  try {
    await kv.hdel(meetingRolesKey(eventId), ...target.keys);
  } catch (err) {
    console.error(`[neo:meeting-roles] hdel failed (event ${eventId})`, err);
    throw new MeetingRoleError("write_failed");
  }
}

/** Strip an elevated role; the person reverts to an ordinary participant. */
export async function demoteToParticipant(eventId: string, userIdentity: UserIdentity): Promise<void> {
  return removeMeetingRole(eventId, userIdentity);
}

/* -------------------------------------------------------------------------- */
/*  Listing                                                                    */
/* -------------------------------------------------------------------------- */

export interface MeetingParticipant {
  /** Clerk userId when known, otherwise the email the row is keyed on. */
  userId: string;
  emails?: string[];
  role: MeetingRole;
  assignedAt: number;
  assignedBy: string | null;
}

/**
 * Everyone with standing in the meeting: the owner (from the event record)
 * plus every hash row. Rows sharing an identity are collapsed, highest rank
 * wins, and the owner absorbs any row that turns out to be them.
 *
 * Sorted owner first, then by rank, then newest assignment first.
 */
export async function getMeetingParticipants(
  eventId: string,
  event?: NeoEvent | null
): Promise<MeetingParticipant[]> {
  const rows: Array<{ key: string; entry: RoleAssignmentEntry }> = [];

  if (!isKvConfigured()) {
    warnKvOnce();
    memBucket(eventId).forEach((entry, key) => rows.push({ key, entry }));
  } else {
    try {
      const all = (await kv.hgetall(meetingRolesKey(eventId))) as Record<string, unknown> | null;
      for (const [key, raw] of Object.entries(all || {})) {
        const entry = parseEntry(raw);
        if (entry) rows.push({ key, entry });
      }
    } catch (err) {
      console.error(`[neo:meeting-roles] hgetall failed (event ${eventId})`, err);
    }
  }

  const ownerId = event?.ownerUserId || "";
  const ownerEmail = (event?.ownerEmail || "").toLowerCase();

  // Group by person: a userId row and an email row for the same human collapse.
  const byId = new Map<string, MeetingParticipant>();
  const emailToId = new Map<string, string>();

  const isOwnerKey = (k: string) =>
    (!!ownerId && k.toLowerCase() === ownerId.toLowerCase()) || (!!ownerEmail && k === ownerEmail);

  for (const { key, entry } of rows) {
    if (isOwnerKey(key)) continue; // owner outranks any stored row
    const email = looksLikeEmail(key) ? key : null;
    const id = email ? emailToId.get(email) || key : key;
    if (!email) {
      // Nothing links a userId row to an email row without the event record,
      // so they stay separate unless a later row supplies the association.
    }
    const existing = byId.get(id);
    if (existing) {
      if (RANK[entry.role] > RANK[existing.role]) {
        existing.role = entry.role;
        existing.assignedAt = entry.assignedAt;
        existing.assignedBy = entry.assignedBy;
      }
      if (email && !existing.emails?.includes(email)) {
        existing.emails = [...(existing.emails || []), email];
      }
    } else {
      byId.set(id, {
        userId: id,
        emails: email ? [email] : undefined,
        role: entry.role,
        assignedAt: entry.assignedAt,
        assignedBy: entry.assignedBy,
      });
      if (email) emailToId.set(email, id);
    }
  }

  const out: MeetingParticipant[] = [];
  byId.forEach((p) => out.push(p));

  if (ownerId) {
    out.unshift({
      userId: ownerId,
      emails: ownerEmail ? [ownerEmail] : undefined,
      role: "owner",
      assignedAt: event?.createdAt ? Date.parse(event.createdAt) || 0 : 0,
      assignedBy: null,
    });
  }

  return out.sort((a, b) => {
    const byRank = RANK[b.role] - RANK[a.role];
    if (byRank !== 0) return byRank;
    return b.assignedAt - a.assignedAt;
  });
}

/* -------------------------------------------------------------------------- */
/*  Threshold check                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Does this person hold at least `requiredRole` in this meeting?
 *
 * Ordering comes from RANK in permissions.ts — this module never compares roles
 * itself, so there is exactly one ladder in the codebase.
 *
 * Note: an unassigned user returns false even against `"participant"`, because
 * no row means no membership. That is deliberate — it is the membership test
 * the old code never had.
 */
export async function checkMeetingRole(
  eventId: string,
  userIdentity: UserIdentity,
  requiredRole: MeetingRole
): Promise<boolean> {
  if (!eventId || !isMeetingRole(requiredRole)) return false;
  const id = resolveIdentity(userIdentity);
  if (id.keys.length === 0) return false;
  try {
    const role = await highestRoleFor(eventId, id);
    if (!role) return false;
    return RANK[role] >= RANK[requiredRole];
  } catch (err) {
    console.error(`[neo:meeting-roles] checkMeetingRole failed (event ${eventId})`, err);
    return false;
  }
}

/**
 * Drop every role assignment for an event. Called by eventStore.delete() —
 * without it the hash outlives the event it belongs to and leaks forever.
 */
export async function deleteAllMeetingRoles(eventId: string): Promise<void> {
  if (!eventId) return;
  if (!isKvConfigured()) {
    memRoles.delete(eventId);
    return;
  }
  try {
    await kv.del(meetingRolesKey(eventId));
  } catch (err) {
    console.error(`[neo:meeting-roles] del failed (event ${eventId})`, err);
  }
}

/** Test seam: drop the in-memory fallback. No effect when KV is configured. */
export function __resetInMemoryRoles(): void {
  memRoles.clear();
}

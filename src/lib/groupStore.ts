// src/lib/groupStore.ts
//
// Groups: a standing set of people a host meets with again and again.
// Phase 1 is the group itself, its members and their roles.
//
// Storage (Vercel KV, in-memory Map fallback like attendance.ts / chatStore.ts)
//   neo:group:<gid>              hash   id, name, description, iconUrl, creatorId,
//                                       sourceEventId, createdAt, updatedAt, settings
//   neo:group:<gid>:members      hash   userId -> { role, name, email?, joinedAt, addedBy }
//   neo:group:<gid>:activity     list   newest first, capped at 200
//   neo:user:<uid>:groups        set    group ids the user belongs to
//   neo:groupinvite:<token>      JSON   { gid, createdBy, createdAt }, 72 h TTL
//
// Roles use the meeting ladder from permissions.ts: owner > host > moderator >
// participant ("Member" on screen). Every ordering question is answered there;
// this module only applies the answers.
//
// Removing someone from a group never touches attendance: the attendance
// journal belongs to the meeting, not to the group, and this module does not
// import it.
//
// Pure module: no Clerk, no Next, no HTTP.

import { kv } from "@vercel/kv";
import { generateId } from "@/lib/eventStore";
import { inviteStore } from "@/lib/inviteStore";
import {
  RANK,
  can,
  canManageRole,
  isMeetingRole,
  type Actor,
  type MeetingRole,
  type Permission,
} from "@/lib/permissions";

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export interface GroupSettings {
  /** Minutes between rings when a member does not answer a group call. */
  retryIntervalMin: number;
  /** How many times a member is rung before giving up. */
  maxAttempts: number;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  creatorId: string;
  /** The meeting whose attendees the group was created from, if any. */
  sourceEventId?: string;
  createdAt: string;
  updatedAt: string;
  settings: GroupSettings;
}

export interface GroupMember {
  userId: string;
  role: MeetingRole;
  name: string;
  email?: string;
  /** Epoch ms. */
  joinedAt: number;
  /** Clerk userId of whoever added them; null when they came in by invite link. */
  addedBy: string | null;
}

export type GroupActivityType =
  | "created"
  | "updated"
  | "member_added"
  | "member_removed"
  | "member_left"
  | "member_joined"
  | "role_changed"
  | "ownership_transferred"
  | "invite_created";

export interface GroupActivity {
  /** Epoch ms. */
  ts: number;
  actorId: string | null;
  type: GroupActivityType;
  detail: string;
}

export interface GroupInvite {
  gid: string;
  createdBy: string;
  /** Epoch ms. */
  createdAt: number;
}

/** Someone about to become a member: who they are, not what they may do. */
export interface NewMember {
  userId: string;
  name: string;
  email?: string;
}

export const DEFAULT_GROUP_SETTINGS: GroupSettings = { retryIntervalMin: 3, maxAttempts: 5 };

export const GROUP_LIMITS = {
  nameMax: 80,
  descriptionMax: 500,
  iconUrlMax: 2048,
  membersMax: 500,
  activityMax: 200,
  retryIntervalMin: { min: 1, max: 60 },
  maxAttempts: { min: 1, max: 10 },
} as const;

export const GROUP_INVITE_TTL_SECONDS = 72 * 60 * 60;

/**
 * Refusals carry the code the API answers with and the status to answer it
 * with, so routes can pass them straight through.
 */
export class GroupError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400
  ) {
    super(message);
    this.name = "GroupError";
  }
}

/* -------------------------------------------------------------------------- */
/*  Role rules                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The permission that lets someone manage a member holding `role`. Each sits
 * one rank above the role it manages; nobody manages the owner.
 */
export function managePermissionFor(role: MeetingRole): Permission | null {
  switch (role) {
    case "participant":
      return "group:members:manage";
    case "moderator":
      return "group:moderators:manage";
    case "host":
      return "group:hosts:manage";
    default:
      return null;
  }
}

/** True when `actor` may add or remove a member who holds `role`. */
export function canManageGroupMember(actor: Actor, role: MeetingRole): boolean {
  const permission = managePermissionFor(role);
  if (!permission) return false;
  return can(actor, permission) && RANK[actor.role] > RANK[role];
}

/**
 * True when `actor` may move a member from `from` to `to`. Both roles must be
 * below the actor's own: canManageRole() checks one role at a time and needs
 * host rank, so a moderator can never change anyone's role.
 */
export function canChangeGroupRole(actor: Actor, from: MeetingRole, to: MeetingRole): boolean {
  if (from === "owner" || to === "owner") return false;
  return (
    canManageRole(actor, from, false) &&
    canManageRole(actor, to, false) &&
    canManageGroupMember(actor, from) &&
    canManageGroupMember(actor, to)
  );
}

/** Roles `actor` may hand out, highest first — what a role menu should offer. */
export function assignableGroupRoles(actor: Actor): MeetingRole[] {
  return (["host", "moderator", "participant"] as MeetingRole[]).filter(
    (r) => canManageRole(actor, r, false) && canManageGroupMember(actor, r)
  );
}

/** What the caller's rank lets them do here — the UI hides what is false. */
export interface GroupCapabilities {
  role: MeetingRole;
  manageMembers: boolean;
  /** Roles the caller can give someone, highest first; empty for a moderator. */
  assignableRoles: MeetingRole[];
  /** Existing roles whose holders the caller can remove. */
  removableRoles: MeetingRole[];
  editSettings: boolean;
  deleteGroup: boolean;
  transferOwnership: boolean;
  leave: boolean;
}

export function groupCapabilities(actor: Actor): GroupCapabilities {
  return {
    role: actor.role,
    manageMembers: can(actor, "group:members:manage"),
    assignableRoles: assignableGroupRoles(actor),
    removableRoles: (["host", "moderator", "participant"] as MeetingRole[]).filter((r) =>
      canManageGroupMember(actor, r)
    ),
    editSettings: can(actor, "group:settings"),
    deleteGroup: can(actor, "group:delete"),
    transferOwnership: actor.role === "owner",
    leave: can(actor, "group:leave") && actor.role !== "owner",
  };
}

/**
 * The whole access decision for one request, without any I/O: 401 when signed
 * out, 404 when the group is missing or the caller is not in it (the same
 * answer, so a guessed id reveals nothing), 403 when their rank is too low.
 */
export function decideGroupAccess(
  identity: { userId: string | null; emails: string[]; isPlatformAdmin: boolean },
  group: Group | null,
  member: GroupMember | null,
  permission: Permission
): { ok: true; actor: Actor } | { ok: false; status: 401 | 403 | 404; actor: Actor | null } {
  if (!identity.userId) return { ok: false, status: 401, actor: null };
  if (!group || !member) return { ok: false, status: 404, actor: null };
  const actor = groupActor({ ...identity, userId: identity.userId }, member);
  return can(actor, permission) ? { ok: true, actor } : { ok: false, status: 403, actor };
}

/** An Actor for one group, from the caller's identity and their membership. */
export function groupActor(
  identity: { userId: string; emails: string[]; isPlatformAdmin: boolean },
  member: GroupMember
): Actor {
  return {
    userId: identity.userId,
    emails: identity.emails,
    isPlatformAdmin: identity.isPlatformAdmin,
    role: member.role,
    isOwner: member.role === "owner",
    reason: member.role === "owner" ? "owner" : "assignment",
  };
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new GroupError("invalid_name");
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.length > GROUP_LIMITS.nameMax) throw new GroupError("invalid_name");
  return name;
}

function cleanDescription(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") throw new GroupError("invalid_description");
  const text = raw.trim();
  if (text.length > GROUP_LIMITS.descriptionMax) throw new GroupError("invalid_description");
  return text;
}

function cleanIconUrl(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string" || raw.length > GROUP_LIMITS.iconUrlMax) {
    throw new GroupError("invalid_icon");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new GroupError("invalid_icon");
  }
  if (url.protocol !== "https:") throw new GroupError("invalid_icon");
  return url.toString();
}

function cleanSettings(raw: unknown, base: GroupSettings): GroupSettings {
  if (raw == null) return base;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new GroupError("invalid_settings");
  const r = raw as Record<string, unknown>;
  const pick = (key: keyof GroupSettings, range: { min: number; max: number }): number => {
    const v = r[key];
    if (v === undefined) return base[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < range.min || v > range.max) {
      throw new GroupError("invalid_settings");
    }
    return v;
  };
  return {
    retryIntervalMin: pick("retryIntervalMin", GROUP_LIMITS.retryIntervalMin),
    maxAttempts: pick("maxAttempts", GROUP_LIMITS.maxAttempts),
  };
}

function cleanNewMember(raw: NewMember): NewMember {
  const userId = String(raw.userId || "").trim();
  if (!userId) throw new GroupError("invalid_member");
  const name = String(raw.name || "").trim().slice(0, 120) || "Member";
  const email = raw.email ? String(raw.email).trim().toLowerCase().slice(0, 254) : undefined;
  return { userId, name, ...(email ? { email } : {}) };
}

/* -------------------------------------------------------------------------- */
/*  Storage                                                                    */
/* -------------------------------------------------------------------------- */

const groupKey = (gid: string) => `neo:group:${gid}`;
const membersKey = (gid: string) => `neo:group:${gid}:members`;
const activityKey = (gid: string) => `neo:group:${gid}:activity`;
const userGroupsKey = (uid: string) => `neo:user:${uid}:groups`;
const inviteKey = (token: string) => `neo:groupinvite:${token}`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// In-process fallback for tests / unconfigured environments. Same shape as the
// attendance / chatStore fallbacks. NOT durable across lambdas or deploys.
const memGroups = new Map<string, Group>();
const memMembers = new Map<string, Map<string, GroupMember>>();
const memActivity = new Map<string, GroupActivity[]>();
const memUserGroups = new Map<string, Set<string>>();
const memInvites = new Map<string, GroupInvite>();

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn("[neo:groupStore] Vercel KV is not configured - groups are kept in-memory only.");
}

function memMemberBucket(gid: string): Map<string, GroupMember> {
  let b = memMembers.get(gid);
  if (!b) {
    b = new Map();
    memMembers.set(gid, b);
  }
  return b;
}

function memUserBucket(uid: string): Set<string> {
  let b = memUserGroups.get(uid);
  if (!b) {
    b = new Set();
    memUserGroups.set(uid, b);
  }
  return b;
}

/**
 * Group hash fields are written JSON-encoded. The KV client JSON-parses every
 * value it reads back, so a name like "007" stored raw would come back as the
 * number 7; encoding it first makes the round trip exact.
 */
function encodeGroup(g: Group): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(g)) {
    if (v !== undefined) out[k] = JSON.stringify(v);
  }
  return out;
}

function decodeField(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function decodeGroup(raw: Record<string, unknown> | null): Group | null {
  if (!raw || typeof raw !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const id = str(raw.id);
  if (!id) return null;
  const settingsRaw = decodeField(raw.settings);
  let settings = DEFAULT_GROUP_SETTINGS;
  try {
    settings = cleanSettings(settingsRaw, DEFAULT_GROUP_SETTINGS);
  } catch {
    // A malformed settings field falls back to the defaults rather than
    // making the group unreadable.
  }
  const sourceEventId = str(raw.sourceEventId);
  return {
    id,
    name: str(raw.name),
    description: str(raw.description),
    iconUrl: str(raw.iconUrl),
    creatorId: str(raw.creatorId),
    ...(sourceEventId ? { sourceEventId } : {}),
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
    settings,
  };
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
}

function parseMember(userId: string, raw: unknown): GroupMember | null {
  const o = parseObject(raw);
  if (!o || !isMeetingRole(o.role)) return null;
  const email = typeof o.email === "string" && o.email ? o.email : undefined;
  return {
    userId,
    role: o.role,
    name: typeof o.name === "string" ? o.name : "",
    ...(email ? { email } : {}),
    joinedAt: typeof o.joinedAt === "number" ? o.joinedAt : 0,
    addedBy: typeof o.addedBy === "string" && o.addedBy ? o.addedBy : null,
  };
}

/** The hash value for a member; the userId is the field it is stored under. */
function memberValue(m: GroupMember): string {
  return JSON.stringify({
    role: m.role,
    name: m.name,
    ...(m.email ? { email: m.email } : {}),
    joinedAt: m.joinedAt,
    addedBy: m.addedBy,
  });
}

function parseActivity(raw: unknown): GroupActivity | null {
  const o = parseObject(raw);
  if (!o || typeof o.type !== "string" || typeof o.ts !== "number") return null;
  return {
    ts: o.ts,
    actorId: typeof o.actorId === "string" ? o.actorId : null,
    type: o.type as GroupActivityType,
    detail: typeof o.detail === "string" ? o.detail : "",
  };
}

async function writeGroup(g: Group): Promise<void> {
  if (!isKvConfigured()) {
    memGroups.set(g.id, g);
    return;
  }
  await kv.hset(groupKey(g.id), encodeGroup(g));
}

async function writeMembers(gid: string, members: GroupMember[]): Promise<void> {
  if (members.length === 0) return;
  if (!isKvConfigured()) {
    const bucket = memMemberBucket(gid);
    for (const m of members) {
      bucket.set(m.userId, m);
      memUserBucket(m.userId).add(gid);
    }
    return;
  }
  const fields: Record<string, string> = {};
  for (const m of members) fields[m.userId] = memberValue(m);
  await kv.hset(membersKey(gid), fields);
  await Promise.all(members.map((m) => kv.sadd(userGroupsKey(m.userId), gid)));
}

async function dropMember(gid: string, userId: string): Promise<void> {
  if (!isKvConfigured()) {
    memMembers.get(gid)?.delete(userId);
    memUserGroups.get(userId)?.delete(gid);
    return;
  }
  await kv.hdel(membersKey(gid), userId);
  await kv.srem(userGroupsKey(userId), gid);
}

function sortMembers(list: GroupMember[]): GroupMember[] {
  return list.sort((a, b) => RANK[b.role] - RANK[a.role] || a.joinedAt - b.joinedAt);
}

/* -------------------------------------------------------------------------- */
/*  Activity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Record something that happened in a group. Never throws: the history is a
 * courtesy, and a KV blip writing it must not undo the change it describes.
 */
export async function appendActivity(
  gid: string,
  entry: Omit<GroupActivity, "ts"> & { ts?: number }
): Promise<void> {
  const full: GroupActivity = {
    ts: entry.ts && Number.isFinite(entry.ts) ? entry.ts : Date.now(),
    actorId: entry.actorId,
    type: entry.type,
    detail: entry.detail.slice(0, 300),
  };
  if (!isKvConfigured()) {
    const list = memActivity.get(gid) ?? [];
    list.unshift(full);
    if (list.length > GROUP_LIMITS.activityMax) list.length = GROUP_LIMITS.activityMax;
    memActivity.set(gid, list);
    return;
  }
  try {
    await kv.lpush(activityKey(gid), JSON.stringify(full));
    await kv.ltrim(activityKey(gid), 0, GROUP_LIMITS.activityMax - 1);
  } catch (err) {
    console.warn("[neo:groupStore] activity write failed", err);
  }
}

/** Newest first. */
export async function listActivity(gid: string, limit = 50): Promise<GroupActivity[]> {
  const capped = Math.max(1, Math.min(limit, GROUP_LIMITS.activityMax));
  if (!isKvConfigured()) return (memActivity.get(gid) ?? []).slice(0, capped);
  try {
    const raw = (await kv.lrange(activityKey(gid), 0, capped - 1)) as unknown[];
    return raw.map(parseActivity).filter((x): x is GroupActivity => x !== null);
  } catch (err) {
    console.warn("[neo:groupStore] activity read failed", err);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Groups                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateGroupInput {
  name: unknown;
  description?: unknown;
  iconUrl?: unknown;
  sourceEventId?: string;
}

/**
 * Create a group with `creator` as its Owner and `members` as Members. The
 * caller decides who may be in `members` (the route checks them against a
 * meeting's attendees); this function only stores them.
 */
export async function createGroup(
  input: CreateGroupInput,
  creator: NewMember,
  members: NewMember[] = []
): Promise<Group> {
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  const iconUrl = cleanIconUrl(input.iconUrl);
  const owner = cleanNewMember(creator);

  const others = new Map<string, NewMember>();
  for (const m of members) {
    const clean = cleanNewMember(m);
    if (clean.userId !== owner.userId) others.set(clean.userId, clean);
  }
  if (others.size + 1 > GROUP_LIMITS.membersMax) throw new GroupError("too_many_members");

  const now = new Date();
  const group: Group = {
    id: generateId(),
    name,
    description,
    iconUrl,
    creatorId: owner.userId,
    ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    settings: { ...DEFAULT_GROUP_SETTINGS },
  };

  if (!isKvConfigured()) warnOnce();
  await writeGroup(group);
  const ts = now.getTime();
  await writeMembers(group.id, [
    { ...owner, role: "owner", joinedAt: ts, addedBy: owner.userId },
    ...Array.from(others.values()).map(
      (m): GroupMember => ({ ...m, role: "participant", joinedAt: ts, addedBy: owner.userId })
    ),
  ]);
  await appendActivity(group.id, {
    ts,
    actorId: owner.userId,
    type: "created",
    detail:
      others.size > 0
        ? `${owner.name} created the group with ${others.size} ${others.size === 1 ? "member" : "members"}`
        : `${owner.name} created the group`,
  });
  return group;
}

export async function getGroup(gid: string): Promise<Group | null> {
  if (!gid) return null;
  if (!isKvConfigured()) return memGroups.get(gid) ?? null;
  const raw = (await kv.hgetall(groupKey(gid))) as Record<string, unknown> | null;
  return decodeGroup(raw);
}

export interface GroupPatch {
  name?: unknown;
  description?: unknown;
  iconUrl?: unknown;
  settings?: unknown;
}

/** Apply a settings change. Permission is the caller's job (group:settings). */
export async function updateGroup(gid: string, patch: GroupPatch, actorId: string): Promise<Group> {
  const prev = await getGroup(gid);
  if (!prev) throw new GroupError("not_found", 404);

  const next: Group = { ...prev };
  const changed: string[] = [];
  if (patch.name !== undefined) {
    next.name = cleanName(patch.name);
    if (next.name !== prev.name) changed.push("name");
  }
  if (patch.description !== undefined) {
    next.description = cleanDescription(patch.description);
    if (next.description !== prev.description) changed.push("description");
  }
  if (patch.iconUrl !== undefined) {
    next.iconUrl = cleanIconUrl(patch.iconUrl);
    if (next.iconUrl !== prev.iconUrl) changed.push("icon");
  }
  if (patch.settings !== undefined) {
    next.settings = cleanSettings(patch.settings, prev.settings);
    if (next.settings.retryIntervalMin !== prev.settings.retryIntervalMin) changed.push("retry interval");
    if (next.settings.maxAttempts !== prev.settings.maxAttempts) changed.push("max attempts");
  }
  if (changed.length === 0) return prev;

  next.updatedAt = new Date().toISOString();
  await writeGroup(next);
  await appendActivity(gid, { actorId, type: "updated", detail: `Changed ${changed.join(", ")}` });
  return next;
}

/** Delete a group with its members, every member's index entry and its history. */
export async function deleteGroup(gid: string): Promise<boolean> {
  const group = await getGroup(gid);
  if (!group) return false;
  const members = await listMembers(gid);
  if (!isKvConfigured()) {
    for (const m of members) memUserGroups.get(m.userId)?.delete(gid);
    memMembers.delete(gid);
    memActivity.delete(gid);
    memGroups.delete(gid);
    return true;
  }
  await Promise.all(members.map((m) => kv.srem(userGroupsKey(m.userId), gid)));
  await kv.del(membersKey(gid), activityKey(gid), groupKey(gid));
  return true;
}

export interface GroupSummary {
  group: Group;
  role: MeetingRole;
  memberCount: number;
}

/** The groups `userId` belongs to, newest first. Ids that no longer resolve are pruned. */
export async function listGroupsForUser(userId: string): Promise<GroupSummary[]> {
  if (!userId) return [];
  const ids = !isKvConfigured()
    ? Array.from(memUserGroups.get(userId) ?? [])
    : ((await kv.smembers(userGroupsKey(userId))) as unknown[]).map(String);

  const rows = await Promise.all(
    ids.map(async (gid): Promise<GroupSummary | null> => {
      const [group, member, memberCount] = await Promise.all([
        getGroup(gid),
        getMember(gid, userId),
        countMembers(gid),
      ]);
      if (!group || !member) {
        if (!isKvConfigured()) memUserGroups.get(userId)?.delete(gid);
        else await kv.srem(userGroupsKey(userId), gid);
        return null;
      }
      return { group, role: member.role, memberCount };
    })
  );
  return rows
    .filter((r): r is GroupSummary => r !== null)
    .sort((a, b) => b.group.createdAt.localeCompare(a.group.createdAt));
}

/* -------------------------------------------------------------------------- */
/*  Members                                                                    */
/* -------------------------------------------------------------------------- */

export async function getMember(gid: string, userId: string): Promise<GroupMember | null> {
  if (!gid || !userId) return null;
  if (!isKvConfigured()) return memMembers.get(gid)?.get(userId) ?? null;
  const raw = await kv.hget(membersKey(gid), userId);
  return raw == null ? null : parseMember(userId, raw);
}

/** Owner first, then by rank, then by who joined first. */
export async function listMembers(gid: string): Promise<GroupMember[]> {
  if (!isKvConfigured()) return sortMembers(Array.from(memMembers.get(gid)?.values() ?? []));
  const raw = (await kv.hgetall(membersKey(gid))) as Record<string, unknown> | null;
  if (!raw) return [];
  const out: GroupMember[] = [];
  for (const [uid, v] of Object.entries(raw)) {
    const m = parseMember(uid, v);
    if (m) out.push(m);
  }
  return sortMembers(out);
}

export async function countMembers(gid: string): Promise<number> {
  if (!isKvConfigured()) return memMembers.get(gid)?.size ?? 0;
  return kv.hlen(membersKey(gid));
}

async function requireGroup(gid: string): Promise<Group> {
  const group = await getGroup(gid);
  if (!group) throw new GroupError("not_found", 404);
  return group;
}

/**
 * Add people as Members. Anyone already in the group is left exactly as they
 * are (a Host is never quietly demoted by being "added" again).
 */
export async function addMembers(
  gid: string,
  people: NewMember[],
  actor: Actor
): Promise<{ added: GroupMember[]; alreadyMembers: string[] }> {
  await requireGroup(gid);
  if (!canManageGroupMember(actor, "participant")) throw new GroupError("insufficient_rank", 403);

  const existing = await listMembers(gid);
  const have = new Set(existing.map((m) => m.userId));
  const added: GroupMember[] = [];
  const alreadyMembers: string[] = [];
  const now = Date.now();
  for (const p of people) {
    const clean = cleanNewMember(p);
    if (have.has(clean.userId)) {
      alreadyMembers.push(clean.userId);
      continue;
    }
    have.add(clean.userId);
    added.push({ ...clean, role: "participant", joinedAt: now, addedBy: actor.userId });
  }
  if (existing.length + added.length > GROUP_LIMITS.membersMax) {
    throw new GroupError("too_many_members");
  }
  await writeMembers(gid, added);
  for (const m of added) {
    await appendActivity(gid, { ts: now, actorId: actor.userId, type: "member_added", detail: `Added ${m.name}` });
  }
  return { added, alreadyMembers };
}

/** Remove someone else. Leaving is leaveGroup(); removing never touches attendance. */
export async function removeMember(gid: string, targetUserId: string, actor: Actor): Promise<GroupMember> {
  await requireGroup(gid);
  if (actor.userId && actor.userId === targetUserId) throw new GroupError("use_leave");
  const target = await getMember(gid, targetUserId);
  if (!target) throw new GroupError("not_member", 404);
  if (target.role === "owner") throw new GroupError("cannot_target_owner", 403);
  if (!canManageGroupMember(actor, target.role)) throw new GroupError("insufficient_rank", 403);

  await dropMember(gid, targetUserId);
  await appendActivity(gid, { actorId: actor.userId, type: "member_removed", detail: `Removed ${target.name}` });
  return target;
}

/** Change a member's role. Ownership moves only through transferOwnership(). */
export async function setRole(
  gid: string,
  targetUserId: string,
  newRole: MeetingRole,
  actor: Actor
): Promise<GroupMember> {
  await requireGroup(gid);
  if (!isMeetingRole(newRole)) throw new GroupError("invalid_role");
  if (newRole === "owner") throw new GroupError("use_transfer");
  if (actor.userId && actor.userId === targetUserId) throw new GroupError("cannot_manage_self", 403);
  const target = await getMember(gid, targetUserId);
  if (!target) throw new GroupError("not_member", 404);
  if (target.role === "owner") throw new GroupError("cannot_target_owner", 403);
  if (!canChangeGroupRole(actor, target.role, newRole)) throw new GroupError("insufficient_rank", 403);
  if (target.role === newRole) return target;

  const next: GroupMember = { ...target, role: newRole };
  await writeMembers(gid, [next]);
  await appendActivity(gid, {
    actorId: actor.userId,
    type: "role_changed",
    detail: `${target.name}: ${roleLabel(target.role)} → ${roleLabel(newRole)}`,
  });
  return next;
}

/** Hand the group to another member. The previous Owner becomes a Host. */
export async function transferOwnership(
  gid: string,
  newOwnerId: string,
  actor: Actor
): Promise<{ owner: GroupMember; previous: GroupMember }> {
  await requireGroup(gid);
  if (!actor.userId) throw new GroupError("unauthorized", 401);
  const current = await getMember(gid, actor.userId);
  if (!current || current.role !== "owner") throw new GroupError("insufficient_rank", 403);
  if (newOwnerId === actor.userId) throw new GroupError("cannot_manage_self", 403);
  const target = await getMember(gid, newOwnerId);
  if (!target) throw new GroupError("not_member", 404);

  const owner: GroupMember = { ...target, role: "owner" };
  const previous: GroupMember = { ...current, role: "host" };
  await writeMembers(gid, [owner, previous]);
  await appendActivity(gid, {
    actorId: actor.userId,
    type: "ownership_transferred",
    detail: `${current.name} made ${target.name} the owner`,
  });
  return { owner, previous };
}

/** Leave a group. The Owner must hand ownership to someone first. */
export async function leaveGroup(gid: string, userId: string): Promise<GroupMember> {
  await requireGroup(gid);
  const me = await getMember(gid, userId);
  if (!me) throw new GroupError("not_member", 404);
  if (me.role === "owner") throw new GroupError("owner_must_transfer", 409);
  await dropMember(gid, userId);
  await appendActivity(gid, { actorId: userId, type: "member_left", detail: `${me.name} left` });
  return me;
}

/* -------------------------------------------------------------------------- */
/*  Invite links                                                               */
/* -------------------------------------------------------------------------- */

/** A link anyone signed in can use to join as a Member, for 72 hours. */
export async function createInvite(
  gid: string,
  createdBy: string,
  now: number = Date.now()
): Promise<{ token: string; expiresAt: number }> {
  await requireGroup(gid);
  const token = inviteStore.newToken();
  const invite: GroupInvite = { gid, createdBy, createdAt: now };
  if (!isKvConfigured()) {
    memInvites.set(token, invite);
  } else {
    await kv.set(inviteKey(token), JSON.stringify(invite), { ex: GROUP_INVITE_TTL_SECONDS });
  }
  await appendActivity(gid, { ts: now, actorId: createdBy, type: "invite_created", detail: "Created an invite link" });
  return { token, expiresAt: now + GROUP_INVITE_TTL_SECONDS * 1000 };
}

/**
 * The invite behind a token, or null if there is none or it is past 72 hours.
 * The age is checked here as well as by the KV TTL so the in-memory fallback
 * expires too.
 */
export async function getInvite(token: string, now: number = Date.now()): Promise<GroupInvite | null> {
  if (!token || token.length > 64) return null;
  let raw: unknown;
  if (!isKvConfigured()) raw = memInvites.get(token) ?? null;
  else raw = await kv.get(inviteKey(token));
  const o = parseObject(raw);
  if (!o || typeof o.gid !== "string" || typeof o.createdAt !== "number") return null;
  if (now - o.createdAt > GROUP_INVITE_TTL_SECONDS * 1000) return null;
  return { gid: o.gid, createdBy: typeof o.createdBy === "string" ? o.createdBy : "", createdAt: o.createdAt };
}

/** Join through an invite link. Someone already in the group keeps their role. */
export async function redeemInvite(
  token: string,
  person: NewMember,
  now: number = Date.now()
): Promise<{ group: Group; member: GroupMember; alreadyMember: boolean }> {
  const invite = await getInvite(token, now);
  if (!invite) throw new GroupError("invite_expired", 410);
  const group = await getGroup(invite.gid);
  if (!group) throw new GroupError("invite_expired", 410);

  const clean = cleanNewMember(person);
  const existing = await getMember(group.id, clean.userId);
  if (existing) return { group, member: existing, alreadyMember: true };

  if ((await countMembers(group.id)) + 1 > GROUP_LIMITS.membersMax) {
    throw new GroupError("too_many_members");
  }
  const member: GroupMember = { ...clean, role: "participant", joinedAt: now, addedBy: null };
  await writeMembers(group.id, [member]);
  await appendActivity(group.id, { ts: now, actorId: clean.userId, type: "member_joined", detail: `${clean.name} joined with an invite link` });
  return { group, member, alreadyMember: false };
}

/* -------------------------------------------------------------------------- */
/*  Labels                                                                     */
/* -------------------------------------------------------------------------- */

/** What a role is called in a group: the ladder's "participant" is a Member. */
export function roleLabel(role: MeetingRole): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "host":
      return "Host";
    case "moderator":
      return "Moderator";
    default:
      return "Member";
  }
}

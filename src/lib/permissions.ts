// src/lib/permissions.ts
//
// The single source of truth for "who may do what" inside a NeoConference
// event. Pure module: no Clerk, no Next, no KV — so it runs on the Edge, in
// Node, in the LiveKit token route, and in tests without a request context.
//
// Two exports matter:
//   PERMISSIONS  — the catalog. Every capability in the product, and the
//                  minimum rank required to exercise it.
//   can()        — the only function allowed to answer an authorization
//                  question. API routes, the LiveKit token grant, and the
//                  in-room UI all go through it, so they can never disagree.
//
// Adding a capability = one line in PERMISSIONS. Adding a role = one line in
// RANK. Nothing else in the codebase should hardcode a role comparison.

import type { EventRole, RoleAssignment } from "@/types/event";

/* -------------------------------------------------------------------------- */
/*  Roles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The meeting-role ladder. Higher rank strictly implies every capability of
 * every lower rank — that invariant is what makes `can()` a single comparison
 * instead of a table lookup per role.
 */
export type MeetingRole = "owner" | "host" | "moderator" | "participant";

export const RANK: Record<MeetingRole, number> = {
  owner: 40,
  host: 30,
  moderator: 20,
  participant: 10,
};

export const MEETING_ROLES: MeetingRole[] = ["owner", "host", "moderator", "participant"];

export function isMeetingRole(v: unknown): v is MeetingRole {
  return typeof v === "string" && (MEETING_ROLES as string[]).includes(v);
}

/**
 * Legacy `EventRole` values (and the undeclared "attendee" string that the
 * token route and chatStore actually write) mapped onto the ladder.
 *
 * `cohost` becomes `moderator`: it is what a co-host does today.
 * `speaker`, `viewer`, `ticket-holder` and anything unrecognised collapse to
 * `participant` — none of them gate a single server-side check today, and
 * silently treating an unknown string as elevated is how privilege bugs start.
 */
const LEGACY_ROLE_MAP: Record<string, MeetingRole> = {
  owner: "owner",
  host: "host",
  cohost: "moderator",
  "co-host": "moderator",
  moderator: "moderator",
  speaker: "participant",
  viewer: "participant",
  attendee: "participant",
  "ticket-holder": "participant",
  guest: "participant",
};

export function normalizeRole(raw: string | EventRole | null | undefined): MeetingRole {
  if (!raw) return "participant";
  return LEGACY_ROLE_MAP[String(raw).trim().toLowerCase()] ?? "participant";
}

/** Ladder role -> the wire value the existing clients still expect. */
export function toLegacyRole(role: MeetingRole): string {
  if (role === "owner" || role === "host") return "host";
  if (role === "moderator") return "cohost";
  return "attendee";
}

/* -------------------------------------------------------------------------- */
/*  The catalog                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every capability in the product and the minimum rank that holds it.
 *
 * Read this table as the product spec. If a route enforces something that is
 * not in here, the route is wrong.
 */
export const PERMISSIONS = {
  /* --- meeting lifecycle --- */
  "meeting:start": RANK.host,
  "meeting:end": RANK.host,
  "meeting:edit": RANK.host,
  "meeting:rename": RANK.owner,
  "meeting:delete": RANK.owner,
  "meeting:transfer": RANK.owner,
  "meeting:domain": RANK.owner,
  "meeting:billing": RANK.owner,

  /* --- media (these are the grants baked into the LiveKit token) --- */
  "media:subscribe": RANK.participant,
  "media:publish": RANK.participant,
  "media:screenshare": RANK.participant,
  "media:chat": RANK.participant,
  "media:reactions": RANK.participant,
  "media:raiseHand": RANK.participant,

  /* --- moderation --- */
  "participant:mute": RANK.moderator,
  "participant:muteAll": RANK.moderator,
  "participant:requestUnmute": RANK.moderator,
  "participant:kick": RANK.host,
  "participant:spotlight": RANK.moderator,

  /* --- role administration --- */
  "role:grant": RANK.host,
  "role:revoke": RANK.host,
  "role:invite": RANK.host,

  /* --- capture & broadcast --- */
  "recording:start": RANK.host,
  "recording:stop": RANK.host,
  "recording:read": RANK.host,
  "recording:delete": RANK.owner,
  "stream:golive": RANK.host,
  "captions:dispatch": RANK.host,
  "transcript:read": RANK.host,
  "summary:generate": RANK.host,

  /* --- queue & rooms --- */
  "waitingRoom:view": RANK.moderator,
  "waitingRoom:admit": RANK.moderator,
  "breakout:manage": RANK.moderator,
  "poll:manage": RANK.moderator,

  /* --- commerce --- */
  "ticket:manage": RANK.owner,
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(v: unknown): v is Permission {
  return typeof v === "string" && v in PERMISSIONS;
}

/**
 * Per-event overrides, persisted on the event record. This is how a host runs
 * a webinar (`"media:publish": RANK.moderator` — only staff on camera) or
 * opens a workshop up (`"breakout:manage": RANK.participant`).
 *
 * Overrides are clamped, never trusted blindly: a permission whose catalog
 * default is owner-only can never be lowered below `host` by an override, so
 * no meeting setting can hand deletion or billing to the room.
 */
export type PermissionOverrides = Partial<Record<Permission, number>>;

const OVERRIDE_FLOOR: Partial<Record<Permission, number>> = {
  "meeting:rename": RANK.owner,
  "meeting:delete": RANK.owner,
  "meeting:transfer": RANK.owner,
  "meeting:domain": RANK.owner,
  "meeting:billing": RANK.owner,
  "recording:delete": RANK.owner,
  "ticket:manage": RANK.owner,
  "role:grant": RANK.host,
  "role:revoke": RANK.host,
  "recording:start": RANK.moderator,
  "recording:stop": RANK.moderator,
  "stream:golive": RANK.moderator,
};

/** Effective rank required for a permission on a given event. */
export function requiredRank(permission: Permission, overrides?: PermissionOverrides): number {
  const base = PERMISSIONS[permission];
  const override = overrides?.[permission];
  if (typeof override !== "number" || !Number.isFinite(override)) return base;
  const floor = OVERRIDE_FLOOR[permission] ?? RANK.participant;
  return Math.max(Math.min(override, RANK.owner), floor);
}

/* -------------------------------------------------------------------------- */
/*  Actor                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A resolved caller. Built once per request by `getActor()` in src/lib/authz.ts
 * (which does the Clerk I/O) and then passed around synchronously.
 *
 * `emails` must only ever contain Clerk-verified addresses. Never populate it
 * from a request body or query string — event role assignments are matched by
 * email, so a forged address here is a full impersonation.
 */
export interface Actor {
  userId: string | null;
  /** Verified email addresses, lowercased. */
  emails: string[];
  /** Platform-level role from src/lib/roles.ts. */
  isPlatformAdmin: boolean;
  /** Where this actor sits on the ladder for the event it was resolved against. */
  role: MeetingRole;
  /** True only for the actual creator of the event record. */
  isOwner: boolean;
  /** Which signal produced `role` — for audit logging. */
  reason: "owner" | "platform-admin" | "assignment" | "anonymous" | "default";
}

export const ANONYMOUS_ACTOR: Actor = {
  userId: null,
  emails: [],
  isPlatformAdmin: false,
  role: "participant",
  isOwner: false,
  reason: "anonymous",
};

/** Minimal event shape needed to resolve a role — keeps this testable. */
export interface Eventish {
  ownerUserId?: string;
  ownerEmail?: string;
  roles?: RoleAssignment[];
  permissionOverrides?: PermissionOverrides;
}

function matchesIdentity(identifier: string, userId: string | null, emails: string[]): boolean {
  const id = (identifier || "").trim().toLowerCase();
  if (!id) return false;
  if (userId && id === userId.toLowerCase()) return true;
  return emails.includes(id);
}

/**
 * Pure role resolution. `getActor()` in authz.ts wraps this with the Clerk
 * lookups; this function is what tests and the token route call.
 *
 * Resolution order — first match wins:
 *   1. no userId            -> participant (anonymous)
 *   2. event owner          -> owner
 *   3. platform admin       -> owner rank, isOwner:false (acting as, not is)
 *   4. roles[] assignment   -> mapped through normalizeRole, highest wins
 *   5. otherwise            -> participant
 */
export function resolveRole(
  event: Eventish | null | undefined,
  identity: { userId: string | null; emails: string[]; isPlatformAdmin: boolean }
): Actor {
  const { userId, emails, isPlatformAdmin } = identity;
  const base = { userId, emails, isPlatformAdmin };

  if (!userId) return { ...ANONYMOUS_ACTOR };
  if (!event) {
    return { ...base, role: "participant", isOwner: false, reason: "default" };
  }

  const ownerEmail = (event.ownerEmail || "").toLowerCase();
  const isOwner =
    (!!event.ownerUserId && event.ownerUserId === userId) ||
    (ownerEmail !== "" && emails.includes(ownerEmail));

  if (isOwner) return { ...base, role: "owner", isOwner: true, reason: "owner" };

  // Permanent admins act as owner of any room they enter, but are never
  // recorded as the owner — transfer, billing and audit all care about that.
  if (isPlatformAdmin) {
    return { ...base, role: "owner", isOwner: false, reason: "platform-admin" };
  }

  const assignments: RoleAssignment[] = event.roles || [];
  let best: MeetingRole | null = null;
  for (const a of assignments) {
    if (!matchesIdentity(a.identifier, userId, emails)) continue;
    const mapped = normalizeRole(a.role);
    if (best === null || RANK[mapped] > RANK[best]) best = mapped;
  }
  if (best) return { ...base, role: best, isOwner: false, reason: "assignment" };

  return { ...base, role: "participant", isOwner: false, reason: "default" };
}

/* -------------------------------------------------------------------------- */
/*  The check                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The one authorization primitive. Every route, the LiveKit token grant, and
 * every server component gate calls this and nothing else.
 *
 * Anonymous callers hold no permission at all — including the participant-rank
 * ones. Public reads (a replay page, a public event landing page) are not
 * permissions; they are unauthenticated routes and must not call `can()`.
 */
export function can(actor: Actor, permission: Permission, overrides?: PermissionOverrides): boolean {
  if (!actor.userId) return false;
  return RANK[actor.role] >= requiredRank(permission, overrides);
}

/** Every permission the actor currently holds. Useful for shipping the UI a capability set. */
export function grantsFor(actor: Actor, overrides?: PermissionOverrides): Permission[] {
  if (!actor.userId) return [];
  return ALL_PERMISSIONS.filter((p) => RANK[actor.role] >= requiredRank(p, overrides));
}

/**
 * Rank-ordering guard for role administration: you may never grant or revoke
 * at or above your own rank. This is what stops a moderator minting moderators
 * and a host demoting the owner.
 */
export function canManageRole(actor: Actor, targetRole: MeetingRole, targetIsOwner: boolean): boolean {
  if (!actor.userId) return false;
  if (targetIsOwner) return false;
  if (!can(actor, "role:grant")) return false;
  return RANK[actor.role] > RANK[targetRole];
}

import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import type { RoleAssignment } from "@/types/event";
import { can, resolveRole, type Actor } from "@/lib/permissions";

export type Role = "admin" | "staff" | "user";

const VALID_ROLES: Role[] = ["admin", "staff", "user"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (VALID_ROLES as string[]).includes(value);
}

/**
 * Read role from a Clerk user's publicMetadata.
 * Returns "user" by default if no role is set or the value is invalid.
 */
export function readRoleFromMetadata(metadata: unknown): Role {
  if (metadata && typeof metadata === "object" && "role" in metadata) {
    const r = (metadata as { role?: unknown }).role;
    if (isRole(r)) return r;
  }
  return "user";
}

/**
 * Permanent-admin list, sourced from the ADMIN_EMAILS env var.
 * Comma-separated, case-insensitive, whitespace-tolerant. Empty/missing -> [].
 * Authority lives in the env var; we do NOT persist these to Clerk so that
 * removing an email from ADMIN_EMAILS revokes admin on the next request.
 */
function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/** Returns true iff the given email is in ADMIN_EMAILS. Null-safe. */
export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const target = email.trim().toLowerCase();
  if (!target) return false;
  return getAdminEmails().includes(target);
}

/** True iff the signed-in user's primary/verified emails include an ADMIN_EMAILS entry. */
export async function isCurrentUserAdmin(): Promise<boolean> {
  const u = await currentUser().catch(() => null);
  if (!u) return false;
  const emails = (u.emailAddresses || []).map((e) => e.emailAddress.toLowerCase());
  return emails.some((e) => isAdmin(e));
}

/**
 * Get the current signed-in user's role.
 *
 * Resolution order:
 *   1. ADMIN_EMAILS env-var list — permanent admins beat all other signals.
 *   2. Explicit Clerk publicMetadata.role (admin/staff) — non-"user" wins.
 *   3. BOOTSTRAP_ADMIN_EMAIL single-email seed — promotes to admin and
 *      persists to publicMetadata so subsequent calls are fast.
 *
 * Returns null if the user is not signed in.
 */
export async function getCurrentRole(): Promise<Role | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const emails = user.emailAddresses?.map((e) => e.emailAddress.toLowerCase()) ?? [];

  if (emails.some((e) => isAdmin(e))) return "admin";

  const existing = readRoleFromMetadata(user.publicMetadata);
  if (existing !== "user") return existing;

  const bootstrap = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase().trim();
  if (bootstrap && emails.includes(bootstrap)) {
    await client.users.updateUserMetadata(userId, {
      publicMetadata: { ...(user.publicMetadata ?? {}), role: "admin" },
    });
    return "admin";
  }

  return existing;
}

/**
 * Helper for API routes: returns role only if it matches an allowed list,
 * otherwise null. Also returns the userId so callers can log/audit.
 */
export async function requireRole(allowed: Role[]): Promise<{ userId: string; role: Role } | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const role = await getCurrentRole();
  if (!role || !allowed.includes(role)) return null;
  return { userId, role };
}

/* ----------------------------- assertOwnerOrAdmin ---------------------------- */

/** Minimal shape needed from an event record for ownership/role checks. */
export type Eventish = {
  ownerUserId?: string;
  ownerEmail?: string;
  roles?: RoleAssignment[];
  permissionOverrides?: Record<string, number>;
};

export type AuthzResult =
  | { ok: true; reason: "owner" | "admin" | "cohost" | "host" }
  | { ok: false };

export interface AuthzOptions {
  /** Accept users in event.roles[] with role === 'cohost'. */
  allowCohost?: boolean;
  /** Accept users in event.roles[] with role === 'host' OR 'cohost'.
   *  Implies allowCohost. */
  allowHostlike?: boolean;
}

/**
 * @deprecated Compatibility shim. New code should use
 * `authorize(event, permission)` or `requirePermission(...)` from
 * src/lib/authz.ts, which name the capability instead of a role tier.
 *
 * This now delegates to the permission catalog so there is exactly one
 * authorization implementation in the codebase:
 *
 *   no options                    -> requires 'meeting:delete'  (owner rank)
 *   allowCohost / allowHostlike   -> requires 'participant:mute' (moderator rank)
 *
 * One intentional behaviour change: under `allowCohost`, a roles[] entry with
 * role 'host' now passes. Previously only 'cohost' did, which meant an
 * explicitly-assigned host was refused moderation on their own event.
 */
export async function assertOwnerOrAdmin(
  event: Eventish | null | undefined,
  userId: string | null | undefined,
  options?: AuthzOptions
): Promise<AuthzResult> {
  if (!event || !userId) return { ok: false };

  const u = await currentUser().catch(() => null);
  const emails = (u?.emailAddresses || []).map((e) => e.emailAddress.toLowerCase());
  const actor: Actor = resolveRole(event, {
    userId,
    emails,
    isPlatformAdmin: emails.some((e) => isAdmin(e)),
  });

  const permission =
    options?.allowCohost || options?.allowHostlike ? "participant:mute" : "meeting:delete";

  if (!can(actor, permission, event.permissionOverrides)) return { ok: false };

  if (actor.reason === "platform-admin") return { ok: true, reason: "admin" };
  if (actor.isOwner) return { ok: true, reason: "owner" };
  if (actor.role === "host") return { ok: true, reason: "host" };
  return { ok: true, reason: "cohost" };
}

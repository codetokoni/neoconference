import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import type { RoleAssignment } from "@/types/event";

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
 * Server-side authorization check for event-bound endpoints. Used by Phase 2
 * of the admin override (PR #41) to let permanent admins pass any ownership
 * gate regardless of who actually owns the event record.
 *
 * Returns { ok: true } if the caller is any of:
 *   - the event owner (matched by Clerk userId OR snapshot ownerEmail)
 *   - a permanent admin (ADMIN_EMAILS env var)
 *   - a cohost on event.roles[]  — only if options.allowCohost or .allowHostlike
 *   - a host on event.roles[]    — only if options.allowHostlike
 * Otherwise { ok: false }.
 *
 * The `reason` field on success identifies which path passed (for logging /
 * future audit). On failure there is no reason — the only valid response is
 * 403 and callers don't need to distinguish "not_owner" from "forbidden".
 *
 * Security checklist:
 *  - Returns ok:false for null/undefined event or userId. No false-positive
 *    paths.
 *  - Admin status uses isAdmin() against the ADMIN_EMAILS env var only;
 *    never trusts client-provided claims.
 *  - Caller MUST run auth() before invoking this helper. The helper performs
 *    no authentication.
 *  - Caller MUST look up the event before invoking. A forged eventId fails
 *    the route's own 404 check, never reaching this helper.
 *  - The helper reads the signed-in user's verified emails via currentUser()
 *    (request-scoped, Clerk-verified). It does NOT trust any email passed in
 *    a request body or query string.
 *  - Speaker, viewer, and ticket-holder role assignments NEVER pass this
 *    helper. Only owner / admin / cohost (when enabled) / host-on-roles[]
 *    (when allowHostlike) succeed.
 */
export async function assertOwnerOrAdmin(
  event: Eventish | null | undefined,
  userId: string | null | undefined,
  options?: AuthzOptions
): Promise<AuthzResult> {
  if (!event || !userId) return { ok: false };

  const u = await currentUser().catch(() => null);
  const userEmails = (u?.emailAddresses || []).map((e) => e.emailAddress.toLowerCase());

  if (userEmails.some((e) => isAdmin(e))) {
    return { ok: true, reason: "admin" };
  }

  if (event.ownerUserId && event.ownerUserId === userId) {
    return { ok: true, reason: "owner" };
  }

  const ownerEmail = (event.ownerEmail || "").toLowerCase();
  if (ownerEmail && userEmails.includes(ownerEmail)) {
    return { ok: true, reason: "owner" };
  }

  if (options?.allowCohost || options?.allowHostlike) {
    const match = (event.roles || []).find((r) => {
      const id = (r.identifier || "").toLowerCase();
      if (!id) return false;
      return id === userId.toLowerCase() || userEmails.includes(id);
    });
    if (match) {
      if (options.allowHostlike && (match.role === "host" || match.role === "cohost")) {
        return { ok: true, reason: match.role === "host" ? "host" : "cohost" };
      }
      if (options.allowCohost && match.role === "cohost") {
        return { ok: true, reason: "cohost" };
      }
    }
  }

  return { ok: false };
}

import { auth, clerkClient } from "@clerk/nextjs/server";

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
 * Get the current signed-in user's role.
 * Also handles bootstrap: if BOOTSTRAP_ADMIN_EMAIL matches the current
 * user's primary email and they have no explicit role yet, promote them
 * to admin and persist that to publicMetadata so subsequent calls are fast.
 *
 * Returns null if the user is not signed in.
 */
export async function getCurrentRole(): Promise<Role | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const existing = readRoleFromMetadata(user.publicMetadata);

  if (existing !== "user") return existing;

  const bootstrap = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase().trim();
  if (bootstrap) {
    const emails = user.emailAddresses?.map((e) => e.emailAddress.toLowerCase()) ?? [];
    if (emails.includes(bootstrap)) {
      await client.users.updateUserMetadata(userId, {
        publicMetadata: { ...(user.publicMetadata ?? {}), role: "admin" },
      });
      return "admin";
    }
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

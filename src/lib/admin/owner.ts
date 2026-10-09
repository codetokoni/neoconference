// src/lib/admin/owner.ts
//
// Who owns the platform. The owner is above every administrator role and
// every subscription plan: owner powers are not stored on the account and
// not in KV, so no dashboard action, plan change or expired subscription can
// remove them.
//
// Identity is a verified email on the signed-in Clerk account matching
// PLATFORM_OWNER_EMAILS (comma-separated). An unverified address someone
// adds to their own account does not count. Without the variable the two
// owner addresses below apply.
//
// Transferring ownership is deliberately not possible from the dashboard:
// it is a change to PLATFORM_OWNER_EMAILS in the Vercel project, which
// needs access to the Vercel account and a redeploy — the separate,
// verified process. Every route that suspends, demotes or deletes an
// account refuses the owner.

const DEFAULT_OWNER_EMAILS = ["victoragbasa@gmail.com", "victoragbasa@neoemail.org"];

export function ownerEmails(): string[] {
  const fromEnv = (process.env.PLATFORM_OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_OWNER_EMAILS;
}

/** Where the owner list comes from, for the Security page. */
export function ownerSource(): "env" | "default" {
  return (process.env.PLATFORM_OWNER_EMAILS || "").trim() ? "env" : "default";
}

/** The shape Clerk's backend User and currentUser() share. */
export interface ClerkEmailish {
  emailAddress: string;
  verification?: { status?: string | null } | null;
}

/** Lower-cased addresses Clerk has verified on this account. */
export function verifiedEmails(list: ClerkEmailish[] | null | undefined): string[] {
  return (list ?? [])
    .filter((e) => e.verification?.status === "verified")
    .map((e) => e.emailAddress.trim().toLowerCase());
}

export function isOwnerEmailList(list: ClerkEmailish[] | null | undefined): boolean {
  const owners = ownerEmails();
  return verifiedEmails(list).some((e) => owners.includes(e));
}

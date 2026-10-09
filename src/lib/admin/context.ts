// src/lib/admin/context.ts
//
// Who is calling the admin area and what they may do. Every /api/admin route
// goes through requireAdmin(); the /admin layout through loadAdminForPage().
// The UI hiding a button is a courtesy — this is the check.
//
// Resolution:
//   1. Owner (verified email in PLATFORM_OWNER_EMAILS): every permission.
//      Nothing in KV can suspend, demote or remove the owner.
//   2. Administrator record in KV: its role's permissions, unless suspended.
//   3. An admin from before roles existed (ADMIN_EMAILS, or Clerk
//      publicMetadata.role "admin") is adopted as a Super admin record the
//      first time they arrive, so the owner can see, change or suspend them.
//   4. Everyone else: not an administrator.
// Then two-factor: enrolled, a valid admin session for this Clerk session,
// and for sensitive actions a code entered in the last 10 minutes.

import * as React from "react";
import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { isAdmin as isEnvAdmin, readRoleFromMetadata } from "@/lib/roles";
import { ALL_ADMIN_PERMISSIONS, SENSITIVE_PERMISSIONS, type AdminPermission } from "@/lib/admin/catalog";
import { isOwnerEmailList, verifiedEmails, type ClerkEmailish } from "@/lib/admin/owner";
import { getMember, getRole, saveMember, type AdminMember } from "@/lib/admin/store";
import { recordAdminAction } from "@/lib/admin/audit";
import {
  ADMIN_SESSION_COOKIE,
  STEP_UP_MS,
  cookieFrom,
  mfaStatus,
  readAdminSession,
  type AdminSession,
} from "@/lib/admin/mfa";

export interface AdminContext {
  userId: string;
  sessionId: string | null;
  email: string;
  name: string;
  isOwner: boolean;
  roleId: string;
  roleName: string;
  permissions: AdminPermission[];
  member: AdminMember | null;
  mfa: {
    enrolled: boolean;
    verified: boolean;
    stepUpFresh: boolean;
    session: AdminSession | null;
  };
}

export type AdminRefusal =
  | "signed_out"
  | "not_admin"
  | "admin_suspended"
  | "mfa_enrollment_required"
  | "mfa_required"
  | "forbidden"
  | "step_up_required";

const MESSAGES: Record<AdminRefusal, string> = {
  signed_out: "Sign in first.",
  not_admin: "This account is not a platform administrator.",
  admin_suspended: "Your administrator access is suspended.",
  mfa_enrollment_required: "Set up two-factor authentication to use the admin area.",
  mfa_required: "Enter your authenticator code to continue.",
  forbidden: "Your administrator role does not allow this.",
  step_up_required: "Confirm with a fresh authenticator code to do this.",
};

type Identity =
  | { kind: "signed_out" }
  | { kind: "not_admin" | "admin_suspended"; userId: string }
  | { kind: "admin"; ctx: AdminContext };

/** Resolve the caller. `cookieValue` is the admin-session cookie. */
export async function resolveAdmin(cookieValue: string | null): Promise<Identity> {
  let userId: string | null = null;
  let sessionId: string | null = null;
  try {
    ({ userId, sessionId } = await auth());
  } catch {
    return { kind: "signed_out" };
  }
  if (!userId) return { kind: "signed_out" };

  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const emailList = (user.emailAddresses ?? []) as ClerkEmailish[];
  const verified = verifiedEmails(emailList);
  const email =
    (user as { primaryEmailAddress?: { emailAddress?: string } | null }).primaryEmailAddress?.emailAddress?.toLowerCase() ||
    verified[0] ||
    emailList[0]?.emailAddress?.toLowerCase() ||
    "";
  const u = user as { firstName?: string | null; lastName?: string | null; username?: string | null };
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || email;

  const isOwner = isOwnerEmailList(emailList);
  let member: AdminMember | null = null;
  let roleId = "owner";
  let roleName = "Owner";
  let permissions: AdminPermission[] = ALL_ADMIN_PERMISSIONS;

  if (!isOwner) {
    member = await getMember(userId);
    if (!member) {
      const legacy =
        verified.some((e) => isEnvAdmin(e)) || readRoleFromMetadata(user.publicMetadata) === "admin";
      if (!legacy) return { kind: "not_admin", userId };
      const now = Date.now();
      member = {
        userId,
        email,
        name,
        roleId: "super_admin",
        status: "active",
        appointedBy: "legacy",
        appointedAt: now,
        updatedAt: now,
      };
      await saveMember(member);
      await recordAdminAction({ userId: "system", email: "system" }, null, {
        action: "admin.adopt",
        targetType: "admin",
        targetId: userId,
        targetLabel: email,
        after: { roleId: "super_admin", status: "active" },
        note: "Administrator from before roles existed (ADMIN_EMAILS or Clerk role), recorded as Super admin.",
      });
    }
    if (member.status === "removed") return { kind: "not_admin", userId };
    if (member.status === "suspended") return { kind: "admin_suspended", userId };
    const role = await getRole(member.roleId);
    roleId = member.roleId;
    roleName = role?.name ?? "Unknown role";
    permissions = role?.permissions ?? [];
  }

  const status = await mfaStatus(userId);
  const session = status.enrolled ? readAdminSession(cookieValue, userId, sessionId) : null;
  return {
    kind: "admin",
    ctx: {
      userId,
      sessionId,
      email,
      name,
      isOwner,
      roleId,
      roleName,
      permissions,
      member,
      mfa: {
        enrolled: status.enrolled,
        verified: !!session,
        stepUpFresh: !!session && Date.now() - session.stepUpAt < STEP_UP_MS,
        session,
      },
    },
  };
}

export function refuse(code: AdminRefusal, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json(
    { error: code, message: MESSAGES[code], ...extra },
    { status: code === "signed_out" ? 401 : 403 },
  );
}

export interface RequireOptions {
  /** Ask for a fresh code even if the permission is not marked sensitive. */
  stepUp?: boolean;
  /** Allow before two-factor is set up (the enrollment routes themselves). */
  allowWithoutMfa?: boolean;
}

/**
 * The guard for /api/admin routes. `permission` null = any administrator.
 *
 *   const g = await requireAdmin(req, "users:read");
 *   if (!g.ok) return g.response;
 */
export async function requireAdmin(
  req: Request,
  permission: AdminPermission | AdminPermission[] | null,
  opts: RequireOptions = {},
): Promise<{ ok: true; ctx: AdminContext } | { ok: false; response: NextResponse }> {
  const who = await resolveAdmin(cookieFrom(req.headers.get("cookie"), ADMIN_SESSION_COOKIE));
  if (who.kind !== "admin") return { ok: false, response: refuse(who.kind) };
  const { ctx } = who;
  if (!opts.allowWithoutMfa) {
    if (!ctx.mfa.enrolled) return { ok: false, response: refuse("mfa_enrollment_required") };
    if (!ctx.mfa.verified) return { ok: false, response: refuse("mfa_required") };
  }
  const needed = permission == null ? [] : Array.isArray(permission) ? permission : [permission];
  const missing = needed.filter((p) => !ctx.permissions.includes(p));
  if (missing.length) return { ok: false, response: refuse("forbidden", { permission: missing[0] }) };
  const sensitive = opts.stepUp || needed.some((p) => SENSITIVE_PERMISSIONS.has(p));
  if (sensitive && !ctx.mfa.stepUpFresh) return { ok: false, response: refuse("step_up_required") };
  return { ok: true, ctx };
}

export function can(ctx: Pick<AdminContext, "permissions">, p: AdminPermission): boolean {
  return ctx.permissions.includes(p);
}

export function actorOf(ctx: AdminContext) {
  return { userId: ctx.userId, email: ctx.email };
}

/**
 * For the /admin layout and pages (server components): reads the cookie from
 * next/headers. Cached per request, so the layout and the page share one
 * Clerk lookup.
 */
// React's cache() exists in the React that Next bundles for the server, not
// in plain React 18 (tests and scripts); there it is simply not cached.
const cache: <T>(fn: T) => T = (React as { cache?: <T>(fn: T) => T }).cache ?? ((fn) => fn);

export const loadAdminForPage = cache(async (): Promise<Identity> => {
  const { cookies } = await import("next/headers");
  return resolveAdmin(cookies().get(ADMIN_SESSION_COOKIE)?.value ?? null);
});

/** Whether the administrator viewing this page holds `p`. */
export async function pageAllows(p: AdminPermission): Promise<boolean> {
  const who = await loadAdminForPage();
  return who.kind === "admin" && who.ctx.permissions.includes(p);
}

/** What the browser may know about the signed-in administrator. */
export function publicContext(ctx: AdminContext) {
  return {
    userId: ctx.userId,
    email: ctx.email,
    name: ctx.name,
    isOwner: ctx.isOwner,
    roleId: ctx.roleId,
    roleName: ctx.roleName,
    permissions: ctx.permissions,
    mfa: { enrolled: ctx.mfa.enrolled, verified: ctx.mfa.verified, stepUpFresh: ctx.mfa.stepUpFresh },
    sessionExpiresAt: ctx.mfa.session ? ctx.mfa.session.iat + 12 * 60 * 60 * 1000 : null,
  };
}

export type PublicAdminContext = ReturnType<typeof publicContext>;

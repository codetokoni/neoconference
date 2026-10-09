// /api/admin/team — the platform's administrators.
//
// GET  (admins:read)    owner, administrators, and ADMIN_EMAILS addresses
//                       not yet seen in the admin area
// POST (admins:manage)  { email, roleId } appoint an existing account

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { getMember, getRole, listMembers, listRoles, saveMember, type AdminMember } from "@/lib/admin/store";
import { isOwnerEmailList, ownerEmails, ownerSource, verifiedEmails } from "@/lib/admin/owner";
import { mfaStatus } from "@/lib/admin/mfa";
import { recordAdminAction } from "@/lib/admin/audit";
import { beyondActor, fail, readJson, str } from "@/lib/admin/http";
import { getAdminEmails } from "@/lib/roles";
import { isMailConfigured } from "@/lib/mail";
import { sendTemplateEmail } from "@/lib/comms/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "admins:read");
  if (!g.ok) return g.response;
  const [members, roles] = await Promise.all([listMembers(), listRoles()]);
  const names = new Map(roles.map((r) => [r.id, r.name]));
  const rows = await Promise.all(
    members.map(async (m) => ({
      ...m,
      roleName: names.get(m.roleId) ?? "Unknown role",
      mfaEnrolled: (await mfaStatus(m.userId)).enrolled,
    })),
  );
  const known = new Set(members.map((m) => m.email.toLowerCase()));
  const owners = ownerEmails();
  return NextResponse.json({
    ok: true,
    owner: { emails: owners, source: ownerSource(), youAreOwner: g.ctx.isOwner },
    members: rows,
    pendingFromEnv: getAdminEmails().filter((e) => !known.has(e) && !owners.includes(e)),
  });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "admins:manage");
  if (!g.ok) return g.response;
  const body = await readJson<{ email?: unknown; roleId?: unknown }>(req);
  const email = str(body?.email, 200).toLowerCase();
  const roleId = str(body?.roleId, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("invalid_email", "Enter the email address of their NeoConference account.");
  const role = await getRole(roleId);
  if (!role) return fail("invalid_role", "Choose a role.");
  const over = beyondActor(g.ctx, role.permissions);
  if (over.length) {
    return fail("role_exceeds_yours", "You cannot give a role with permissions you do not have.", 403, { permissions: over });
  }

  const client = await clerkClient();
  const found = await client.users.getUserList({ emailAddress: [email], limit: 1 });
  const user = found.data?.[0];
  if (!user) {
    return fail("no_account", "No account uses that email. They need to sign up at neoconference.app first.", 404);
  }
  if (!verifiedEmails(user.emailAddresses).includes(email)) {
    return fail("email_unverified", "That email is not verified on their account yet.", 400);
  }
  if (isOwnerEmailList(user.emailAddresses)) {
    return fail("owner_already", "That is the platform owner, who already has every permission.", 400);
  }
  if (user.id === g.ctx.userId) return fail("not_on_yourself", "You cannot appoint yourself.", 400);

  const existing = await getMember(user.id);
  if (existing && existing.status !== "removed") {
    return fail("already_admin", "They are already an administrator. Change their role in the list instead.", 409);
  }

  const now = Date.now();
  const member: AdminMember = {
    userId: user.id,
    email,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email,
    roleId: role.id,
    status: "active",
    appointedBy: g.ctx.userId,
    appointedAt: now,
    updatedAt: now,
  };
  await saveMember(member);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "admin.appoint",
    targetType: "admin",
    targetId: user.id,
    targetLabel: email,
    before: existing ? { status: existing.status, roleId: existing.roleId } : null,
    after: { status: "active", roleId: role.id },
  });

  let emailed = false;
  if (isMailConfigured()) {
    const origin = new URL(req.url).origin;
    try {
      // Wording: the "admin.appointed" email template (Admin → Email templates).
      const sent = await sendTemplateEmail("admin.appointed", { appointer: g.ctx.name, roleName: role.name, origin }, { to: email });
      emailed = sent.ok;
      if (!sent.ok) console.warn("[admin/team] appointment email failed", sent.error);
    } catch (err) {
      console.warn("[admin/team] appointment email failed", err);
    }
  }
  return NextResponse.json({ ok: true, member: { ...member, roleName: role.name, mfaEnrolled: false }, emailed }, { status: 201 });
}

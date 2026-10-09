// /api/admin/team/[userId] — one administrator. admins:manage, and a fresh
// authenticator code (it is a sensitive permission).
//
// PATCH  { roleId?, status?: "active" | "suspended", reason? }
// DELETE remove (kept as status "removed", so an ADMIN_EMAILS address is not
//        adopted again on its next visit)
//
// Nobody can act on themselves or on the owner, and nobody but the owner can
// act on an administrator whose role holds permissions they do not.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin, type AdminContext } from "@/lib/admin/context";
import { getMember, getRole, saveMember, type AdminMember } from "@/lib/admin/store";
import { ownerEmails } from "@/lib/admin/owner";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { beyondActor, fail, readJson, str } from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { userId: string } };

async function loadTarget(ctx: AdminContext, userId: string): Promise<{ member: AdminMember } | { response: NextResponse }> {
  if (userId === ctx.userId) {
    return { response: fail("not_on_yourself", "You cannot change your own administrator access.", 400) };
  }
  const member = await getMember(userId);
  if (!member || member.status === "removed") {
    return { response: fail("not_found", "That administrator was not found.", 404) };
  }
  if (ownerEmails().includes(member.email.toLowerCase())) {
    return { response: fail("owner_protected", "The platform owner cannot be changed here.", 403) };
  }
  const role = await getRole(member.roleId);
  const over = beyondActor(ctx, role?.permissions ?? []);
  if (over.length) {
    return {
      response: fail("outranks_you", "Their role has permissions you do not have, so only the owner can change them.", 403, {
        permissions: over,
      }),
    };
  }
  return { member };
}

const snapshot = (m: AdminMember) => ({ roleId: m.roleId, status: m.status, suspendedReason: m.suspendedReason ?? null });

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "admins:manage");
  if (!g.ok) return g.response;
  const t = await loadTarget(g.ctx, params.userId);
  if ("response" in t) return t.response;
  const before = t.member;

  const body = await readJson<{ roleId?: unknown; status?: unknown; reason?: unknown }>(req);
  const next: AdminMember = { ...before, updatedAt: Date.now() };

  if (body?.roleId !== undefined) {
    const role = await getRole(str(body.roleId, 80));
    if (!role) return fail("invalid_role", "Choose a role.");
    const over = beyondActor(g.ctx, role.permissions);
    if (over.length) {
      return fail("role_exceeds_yours", "You cannot give a role with permissions you do not have.", 403, { permissions: over });
    }
    next.roleId = role.id;
  }
  if (body?.status !== undefined) {
    if (body.status === "suspended") {
      next.status = "suspended";
      next.suspendedReason = str(body.reason, 300) || "No reason given";
      next.suspendedAt = Date.now();
    } else if (body.status === "active") {
      next.status = "active";
      delete next.suspendedReason;
      delete next.suspendedAt;
    } else {
      return fail("invalid_status", "Status must be active or suspended.");
    }
  }

  const change = diff(snapshot(before), snapshot(next));
  if (!Object.keys(change.after).length) return NextResponse.json({ ok: true, member: before, unchanged: true });

  await saveMember(next);
  const action =
    before.status !== next.status ? (next.status === "suspended" ? "admin.suspend" : "admin.reactivate") : "admin.role";
  await recordAdminAction(actorOf(g.ctx), req, {
    action,
    targetType: "admin",
    targetId: next.userId,
    targetLabel: next.email,
    ...change,
    note: next.status === "suspended" && action === "admin.suspend" ? next.suspendedReason : undefined,
  });
  return NextResponse.json({ ok: true, member: next });
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "admins:manage");
  if (!g.ok) return g.response;
  const t = await loadTarget(g.ctx, params.userId);
  if ("response" in t) return t.response;
  const next: AdminMember = { ...t.member, status: "removed", updatedAt: Date.now() };
  await saveMember(next);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "admin.remove",
    targetType: "admin",
    targetId: next.userId,
    targetLabel: next.email,
    before: snapshot(t.member),
    after: snapshot(next),
  });
  return NextResponse.json({ ok: true });
}

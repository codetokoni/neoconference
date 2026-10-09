// DELETE /api/admin/team/[userId]/mfa — reset another administrator's
// two-factor (they lost their phone and their recovery codes). They set it
// up again on their next visit. admins:manage + a fresh code; never on
// yourself or the owner.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { getMember, getRole } from "@/lib/admin/store";
import { ownerEmails } from "@/lib/admin/owner";
import { resetMfa } from "@/lib/admin/mfa";
import { recordAdminAction } from "@/lib/admin/audit";
import { beyondActor, fail } from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: { userId: string } }) {
  const g = await requireAdmin(req, "admins:manage");
  if (!g.ok) return g.response;
  if (params.userId === g.ctx.userId) {
    return fail("not_on_yourself", "Use a recovery code to get back in, then replace your codes on the Security page.", 400);
  }
  const member = await getMember(params.userId);
  if (!member || member.status === "removed") return fail("not_found", "That administrator was not found.", 404);
  if (ownerEmails().includes(member.email.toLowerCase())) {
    return fail("owner_protected", "The platform owner's two-factor cannot be reset here.", 403);
  }
  const role = await getRole(member.roleId);
  if (beyondActor(g.ctx, role?.permissions ?? []).length) {
    return fail("outranks_you", "Their role has permissions you do not have, so only the owner can reset them.", 403);
  }
  await resetMfa(params.userId);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "admin.mfa_reset",
    targetType: "admin",
    targetId: member.userId,
    targetLabel: member.email,
  });
  return NextResponse.json({ ok: true });
}

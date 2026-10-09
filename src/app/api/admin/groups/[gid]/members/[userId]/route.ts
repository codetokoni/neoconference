// DELETE /api/admin/groups/[gid]/members/[userId] — remove a member.
// users:write. The group's owner cannot be removed (transfer it first), and
// neither can the platform owner.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { isPlatformOwnerId } from "@/lib/admin/groups";
import { GroupError, adminRemoveMember, getGroup } from "@/lib/groupStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: { gid: string; userId: string } }) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;
  const group = await getGroup(params.gid);
  if (!group) return fail("not_found", "No such group.", 404);
  if (await isPlatformOwnerId(params.userId)) {
    return fail("owner_protected", "The platform owner cannot be removed from a group from the admin area.", 403);
  }
  try {
    const gone = await adminRemoveMember(group.id, params.userId, g.ctx.userId);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "group.member.remove",
      targetType: "group",
      targetId: group.id,
      targetLabel: group.name,
      before: { userId: gone.userId, name: gone.name, role: gone.role },
      after: null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof GroupError) {
      const msg: Record<string, string> = {
        not_member: "That person is not a member of this group.",
        cannot_target_owner: "This is the group's owner. Transfer ownership to someone else first.",
      };
      return fail(err.message, msg[err.message] ?? err.message, err.status);
    }
    throw err;
  }
}

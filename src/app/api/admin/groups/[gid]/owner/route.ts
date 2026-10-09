// POST /api/admin/groups/[gid]/owner { userId } — make a member the group's
// owner; the previous owner stays, as a Host. users:write. Refused when the
// group belongs to the platform owner.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { isPlatformOwnerId } from "@/lib/admin/groups";
import { GroupError, adminTransferOwnership, getGroup, listMembers } from "@/lib/groupStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { gid: string } }) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;
  const group = await getGroup(params.gid);
  if (!group) return fail("not_found", "No such group.", 404);
  const body = await readJson<{ userId?: unknown }>(req);
  const newOwnerId = str(body?.userId, 80);
  if (!newOwnerId) return fail("missing_userId", "Choose the member who becomes the owner.");

  const members = await listMembers(group.id);
  const current = members.find((m) => m.role === "owner") ?? null;
  if (current && (await isPlatformOwnerId(current.userId))) {
    return fail("owner_protected", "This group belongs to the platform owner; it cannot be transferred from the admin area.", 403);
  }
  try {
    const { owner, previous } = await adminTransferOwnership(group.id, newOwnerId, g.ctx.userId);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "group.transfer",
      targetType: "group",
      targetId: group.id,
      targetLabel: group.name,
      before: { ownerId: previous?.userId ?? null, ownerName: previous?.name ?? null },
      after: { ownerId: owner.userId, ownerName: owner.name, previousOwnerRole: previous ? "host" : null },
    });
    return NextResponse.json({ ok: true, owner, previous });
  } catch (err) {
    if (err instanceof GroupError) {
      const msg: Record<string, string> = {
        not_member: "That person is not a member of this group.",
        already_owner: "They already own this group.",
      };
      return fail(err.message, msg[err.message] ?? err.message, err.status);
    }
    throw err;
  }
}

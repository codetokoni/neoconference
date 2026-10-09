// POST /api/admin/users/[id]/deletion/purge — "Delete now". users:delete
// (sensitive: a fresh code).
//
// Only for an account whose deletion was requested and whose retention
// period is over. Refused while the account owns a group (transfer the group
// first, on the Groups page). Then: removed from the groups it is a member
// of, signed out everywhere, deleted in Clerk, and what the admin area kept
// about it (notes, tags) is dropped. The audit trail keeps the record.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { saveMember } from "@/lib/admin/store";
import { forgetUser, getDeletion, loadTargetUser, primaryEmail, signOutEverywhere, summarize, targetGuard } from "@/lib/admin/users";
import { adminRemoveMember, listGroupsForUser } from "@/lib/groupStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "users:delete");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;

  const deletion = await getDeletion(t.user.id);
  if (!deletion) return fail("not_requested", "Request the deletion first; the account is removed only after the retention period.", 409);
  if (deletion.deleteAfter > Date.now()) {
    return fail("retention_not_over", `The retention period runs until ${new Date(deletion.deleteAfter).toISOString()}.`, 409, {
      deleteAfter: deletion.deleteAfter,
    });
  }
  const groups = await listGroupsForUser(t.user.id);
  const owned = groups.filter((s) => s.role === "owner");
  if (owned.length) {
    return fail("owns_groups", "This account owns groups. Transfer them to another member first.", 409, {
      groups: owned.map((s) => ({ id: s.group.id, name: s.group.name })),
    });
  }

  const snapshot = summarize(t.user, { member: t.member, deletion });
  for (const s of groups) await adminRemoveMember(s.group.id, t.user.id, g.ctx.userId);
  await signOutEverywhere(t.user.id);
  const client = await clerkClient();
  await client.users.deleteUser(t.user.id);
  await forgetUser(t.user.id);
  if (t.member && t.member.status !== "removed") await saveMember({ ...t.member, status: "removed", updatedAt: Date.now() });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.delete",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    before: {
      name: snapshot.name,
      email: snapshot.email,
      plan: snapshot.plan,
      createdAt: snapshot.createdAt,
      groupsLeft: groups.map((s) => s.group.id),
      requestedBy: deletion.requestedByEmail,
      requestedAt: new Date(deletion.requestedAt).toISOString(),
    },
    after: { deleted: true },
    note: deletion.reason,
  });
  return NextResponse.json({ ok: true });
}

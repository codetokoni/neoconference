// DELETE /api/admin/users/[id]/sessions — sign the account out everywhere.
// users:suspend. Ends every Clerk session and every device session the app
// keeps (src/lib/sessionStore.ts); the user can sign in again.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { loadTargetUser, primaryEmail, signOutEverywhere, targetGuard } from "@/lib/admin/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "users:suspend");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;

  const ended = await signOutEverywhere(t.user.id);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.sessions.revoke",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    before: { clerkSessions: ended.clerk, deviceSessions: ended.devices },
    after: { clerkSessions: 0, deviceSessions: 0 },
  });
  return NextResponse.json({ ok: true, sessionsEnded: ended });
}

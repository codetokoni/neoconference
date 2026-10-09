// /api/admin/users/[id]/deletion — users:delete (sensitive: a fresh code).
//
// Deleting is two steps with a retention period between them, so a mistake
// or a change of mind can be undone:
//
// POST   { reason } request: the account is suspended (Clerk ban), signed out
//        everywhere and marked pending deletion until DELETION_RETENTION_DAYS
//        from now.
// DELETE cancel the request; the ban is lifted unless the account was
//        already suspended before.
//
// Removing it for good is POST ./purge, only once that date has passed. The
// platform owner is refused by every one of these.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import {
  DELETION_RETENTION_MS,
  clearDeletion,
  getDeletion,
  loadTargetUser,
  primaryEmail,
  setDeletion,
  setSuspension,
  signOutEverywhere,
  targetGuard,
} from "@/lib/admin/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "users:delete");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  const existing = await getDeletion(t.user.id);
  if (existing) return NextResponse.json({ ok: true, unchanged: true, deletion: existing });

  const body = await readJson<{ reason?: unknown }>(req);
  const reason = str(body?.reason, 300) || "No reason given";
  const now = Date.now();
  const deletion = {
    requestedAt: now,
    deleteAfter: now + DELETION_RETENTION_MS,
    requestedById: g.ctx.userId,
    requestedByEmail: g.ctx.email,
    reason,
    wasBanned: !!t.user.banned,
  };
  const client = await clerkClient();
  const ended = await signOutEverywhere(t.user.id, t.user.banned ? undefined : () => client.users.banUser(t.user.id));
  if (!t.user.banned) {
    await setSuspension(t.user.id, { at: now, byId: g.ctx.userId, byEmail: g.ctx.email, reason: `Pending deletion: ${reason}` });
  }
  await setDeletion(t.user.id, deletion);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.delete.request",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    before: { suspended: !!t.user.banned, pendingDeletion: false },
    after: { suspended: true, pendingDeletion: true, deleteAfter: new Date(deletion.deleteAfter).toISOString(), sessionsEnded: ended },
    note: reason,
  });
  return NextResponse.json({ ok: true, deletion });
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "users:delete");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  const existing = await getDeletion(t.user.id);
  if (!existing) return fail("not_requested", "This account is not waiting to be deleted.", 409);

  if (!existing.wasBanned && t.user.banned) {
    const client = await clerkClient();
    await client.users.unbanUser(t.user.id);
    await setSuspension(t.user.id, null);
  }
  await clearDeletion(t.user.id);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.delete.cancel",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    before: { pendingDeletion: true, deleteAfter: new Date(existing.deleteAfter).toISOString() },
    after: { pendingDeletion: false, suspended: existing.wasBanned },
  });
  return NextResponse.json({ ok: true });
}

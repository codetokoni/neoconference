// /api/admin/users/[id]/deletion — users:delete (sensitive: a fresh code).
//
// Deleting is two steps with a grace period between them, so a mistake or a
// change of mind can be undone:
//
// POST   { reason } request: the account is suspended (Clerk ban), signed out
//        everywhere and marked pending deletion until the grace period ends
//        (the "Deleted accounts" retention setting, 30 days by default).
//        Refused while the account is under legal hold.
// DELETE cancel the request; the ban is lifted unless the account was
//        already suspended before.
//
// The request is the one deletion request the Data page queues
// (src/lib/dataGov/requests.ts). Removing the account for good is
// POST ./purge (or "Complete" on the Data page), only once that date has
// passed. The platform owner is refused by every one of these.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { getDeletion, loadTargetUser, primaryEmail, setSuspension, signOutEverywhere, targetGuard } from "@/lib/admin/users";
import { createRequest, getHold } from "@/lib/dataGov/requests";
import { cancelRequest } from "@/lib/dataGov/lifecycle";

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
  if (await getHold(t.user.id)) return fail("legal_hold", "This account is under legal hold and cannot be deleted until the hold is lifted (Data page).", 409);

  const body = await readJson<{ reason?: unknown }>(req);
  const reason = str(body?.reason, 300) || "No reason given";
  const now = Date.now();
  const client = await clerkClient();
  const ended = await signOutEverywhere(t.user.id, t.user.banned ? undefined : () => client.users.banUser(t.user.id));
  if (!t.user.banned) {
    await setSuspension(t.user.id, { at: now, byId: g.ctx.userId, byEmail: g.ctx.email, reason: `Pending deletion: ${reason}` });
  }
  const deletion = await createRequest(
    t.user.id,
    { source: "admin", byId: g.ctx.userId, byEmail: g.ctx.email, reason, wasBanned: !!t.user.banned },
    now,
  );
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
  const r = await cancelRequest(t.user.id, g.ctx.userId);
  if (!r.ok) return fail("not_requested", "This account is not waiting to be deleted.", 409);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.delete.cancel",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    before: { pendingDeletion: true, deleteAfter: new Date(r.closed.deleteAfter).toISOString() },
    after: { pendingDeletion: false, reactivated: r.reactivated },
  });
  return NextResponse.json({ ok: true });
}

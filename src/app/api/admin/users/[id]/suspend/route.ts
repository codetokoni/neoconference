// /api/admin/users/[id]/suspend — users:suspend
//
// POST   { reason } suspend: Clerk bans the account (no new sign-ins) and
//        every session it has, Clerk's and the app's own, is ended.
// DELETE reactivate: lift the ban. Refused while the account is waiting to
//        be deleted — cancel the deletion instead.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import {
  getDeletion,
  getSuspension,
  loadTargetUser,
  primaryEmail,
  setSuspension,
  signOutEverywhere,
  targetGuard,
} from "@/lib/admin/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "users:suspend");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  if (t.user.banned) return NextResponse.json({ ok: true, unchanged: true });

  const body = await readJson<{ reason?: unknown }>(req);
  const reason = str(body?.reason, 300) || "No reason given";
  const client = await clerkClient();
  const ended = await signOutEverywhere(t.user.id, () => client.users.banUser(t.user.id));
  await setSuspension(t.user.id, { at: Date.now(), byId: g.ctx.userId, byEmail: g.ctx.email, reason });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.suspend",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    before: { suspended: false },
    after: { suspended: true, sessionsEnded: ended },
    note: reason,
  });
  return NextResponse.json({ ok: true, sessionsEnded: ended });
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "users:suspend");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  if (await getDeletion(t.user.id)) {
    return fail("pending_deletion", "This account is waiting to be deleted. Cancel the deletion to reactivate it.", 409);
  }
  if (!t.user.banned) return NextResponse.json({ ok: true, unchanged: true });

  const was = await getSuspension(t.user.id);
  const client = await clerkClient();
  await client.users.unbanUser(t.user.id);
  await setSuspension(t.user.id, null);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.reactivate",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    before: { suspended: true, reason: was?.reason ?? null },
    after: { suspended: false },
  });
  return NextResponse.json({ ok: true });
}

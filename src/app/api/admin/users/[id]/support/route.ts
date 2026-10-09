// /api/admin/users/[id]/support — audited support access.
//
// POST   { reason, minutes? } open a support session on this account:
//        users:support_access (sensitive: a fresh code). Time-boxed
//        (SUPPORT_MINUTES), one per administrator at a time, recorded on the
//        account and in the audit trail, and shown as a banner across the
//        admin area until it ends.
// DELETE end it now.
// GET    the account's workspace, read-only, while your session on it is
//        open. Every read is audited.
//
// This is not impersonation. Clerk can mint actor tokens that sign an
// administrator in as the user, but this does not use them: the session
// shows what the account has, it never acts as the user.

import { NextResponse } from "next/server";
import { actorOf, can, refuse, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import {
  SUPPORT_MINUTES,
  activeSupportSession,
  displayName,
  endSupportSession,
  loadTargetUser,
  primaryEmail,
  startSupportSession,
  targetGuard,
} from "@/lib/admin/users";
import { eventStore } from "@/lib/eventStore";
import { listUserMeetings } from "@/lib/userMeetings";
import { listGroupsForUser, listMembers, listPendingMembers } from "@/lib/groupStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "users:support_access");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  const body = await readJson<{ reason?: unknown; minutes?: unknown }>(req);
  const reason = str(body?.reason, 300);
  if (!reason) return fail("reason_required", "Say why you need to look at this account (a ticket number, what the user asked).");
  const asked = typeof body?.minutes === "number" ? Math.round(body.minutes) : SUPPORT_MINUTES.default;
  const minutes = Math.min(Math.max(asked, SUPPORT_MINUTES.min), SUPPORT_MINUTES.max);

  const { session, replaced } = await startSupportSession({
    adminId: g.ctx.userId,
    adminEmail: g.ctx.email,
    userId: t.user.id,
    userEmail: primaryEmail(t.user),
    userName: displayName(t.user),
    reason,
    minutes,
  });
  if (replaced) {
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "support.end",
      targetType: "user",
      targetId: replaced.userId,
      targetLabel: replaced.userEmail,
      before: { supportSession: replaced.id },
      note: "Replaced by a new support session",
    });
  }
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "support.start",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: session.userEmail,
    after: { supportSession: session.id, minutes, expiresAt: new Date(session.expiresAt).toISOString() },
    note: reason,
  });
  return NextResponse.json({ ok: true, session }, { status: 201 });
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, null);
  if (!g.ok) return g.response;
  const open = await activeSupportSession(g.ctx.userId);
  if (!open || open.userId !== params.id) return fail("no_session", "You have no open support session on this account.", 404);
  const ended = await endSupportSession(g.ctx.userId);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "support.end",
    targetType: "user",
    targetId: open.userId,
    targetLabel: open.userEmail,
    before: { supportSession: open.id },
    after: { endedAt: ended ? new Date(ended.endedAt!).toISOString() : null },
  });
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request, { params }: Params) {
  // The fresh code was asked for when the session opened; the permission is
  // checked again so a role change ends access at once.
  const g = await requireAdmin(req, "users:read");
  if (!g.ok) return g.response;
  if (!can(g.ctx, "users:support_access")) return refuse("forbidden", { permission: "users:support_access" });
  const open = await activeSupportSession(g.ctx.userId);
  if (!open || open.userId !== params.id) {
    return fail("support_session_required", "Open a support session on this account to see its workspace.", 403);
  }
  const uid = open.userId;
  const hosted = await eventStore.listByOwner(uid);
  const attended = await listUserMeetings(uid, { limit: 20 });
  const attendedEvents = await Promise.all(attended.eids.map(async (r) => ({ ...r, event: await eventStore.byId(r.eid) })));
  const groups = await listGroupsForUser(uid);
  const groupDetail = await Promise.all(
    groups.map(async (s) => ({
      id: s.group.id,
      name: s.group.name,
      role: s.role,
      members: (await listMembers(s.group.id)).map((m) => ({ userId: m.userId, name: m.name, role: m.role })),
      pending: (await listPendingMembers(s.group.id)).map((p) => ({ kind: p.kind, value: p.value })),
    })),
  );
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "support.view",
    targetType: "user",
    targetId: uid,
    targetLabel: open.userEmail,
    after: { supportSession: open.id, viewed: "workspace" },
  });
  return NextResponse.json({
    session: open,
    meetings: hosted
      .slice()
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
      .map((e) => ({
        id: e.id,
        slug: e.slug,
        name: e.name,
        visibility: e.visibility,
        createdAt: e.createdAt,
        scheduledAt: e.scheduledAt ?? null,
        startedAt: e.startedAt ?? null,
        endedAt: e.endedAt ?? null,
        waitingRoomEnabled: !!e.waitingRoomEnabled,
        isLocked: !!e.isLocked,
        passwordProtected: !!e.password,
        isPermanent: !!e.isPermanent,
      })),
    attended: attendedEvents.map((r) => ({
      eid: r.eid,
      startMs: r.startMs,
      name: r.event?.name ?? null,
      slug: r.event?.slug ?? null,
      hostedBy: r.event?.ownerName ?? r.event?.ownerEmail ?? null,
    })),
    groups: groupDetail,
  });
}

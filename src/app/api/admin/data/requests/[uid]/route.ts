// POST /api/admin/data/requests/[uid] — one account's deletion request and
// legal hold. data:delete (sensitive: a fresh code).
//
//   { action: "cancel" }                 close an open request (grace period or due)
//   { action: "hold", reason }           legal hold: an open request is refused; new ones are too
//   { action: "release" }                lift the hold
//
// Completing is a bulk action with a preview (…/bulk/complete-deletions).
// The owner is refused here like everywhere else.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { loadTargetUser, targetGuard } from "@/lib/admin/users";
import { cancelRequest, placeHold, releaseHold } from "@/lib/dataGov/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { uid: string } }) {
  const g = await requireAdmin(req, "data:delete");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.uid);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  const body = await readJson<{ action?: unknown; reason?: unknown }>(req);
  const uid = t.user.id;

  if (body?.action === "cancel") {
    const r = await cancelRequest(uid, g.ctx.userId);
    if (!r.ok) return fail(r.error, "This account has no open deletion request.", 409);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "data.deletion.cancel",
      targetType: "user",
      targetId: uid,
      before: { status: "open", deleteAfter: new Date(r.closed.deleteAfter).toISOString(), source: r.closed.source },
      after: { status: "cancelled", reactivated: r.reactivated },
    });
    return NextResponse.json({ ok: true, closed: r.closed });
  }

  if (body?.action === "hold") {
    const reason = str(body.reason, 300);
    if (!reason) return fail("reason_required", "Say why the account is under legal hold.", 400);
    const r = await placeHold(uid, { at: Date.now(), byId: g.ctx.userId, byEmail: g.ctx.email, reason });
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "data.hold.place",
      targetType: "user",
      targetId: uid,
      after: { legalHold: true, refusedRequest: r.refused?.id ?? null, reactivated: r.reactivated },
      note: reason,
    });
    return NextResponse.json({ ok: true, refused: r.refused });
  }

  if (body?.action === "release") {
    const h = await releaseHold(uid);
    if (!h) return fail("no_hold", "This account is not under legal hold.", 409);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "data.hold.release",
      targetType: "user",
      targetId: uid,
      before: { legalHold: true, since: new Date(h.at).toISOString() },
      after: { legalHold: false },
    });
    return NextResponse.json({ ok: true });
  }

  return fail("bad_action", "action must be cancel, hold or release.", 400);
}

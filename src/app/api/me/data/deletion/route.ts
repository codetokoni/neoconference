// /api/me/data/deletion — "Delete my account" on the account page.
//
// GET     where my request stands
// POST    { confirm: "DELETE", reason? } ask for my account to be deleted.
//         The account stays usable for the grace period (the deleted-accounts
//         retention setting) so I can change my mind; then an administrator
//         completes it.
// DELETE  take my request back (only one I made myself)
//
// The platform owner's account is refused here, server-side.

import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { recordAdminAction } from "@/lib/admin/audit";
import { isOwnerEmailList } from "@/lib/admin/owner";
import type { ClerkUserish } from "@/lib/admin/users";
import { getRequest, graceMs, lastClosedFor, openStatus } from "@/lib/dataGov/requests";
import { cancelRequest, requestBySelf } from "@/lib/dataGov/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONFIRM_WORD = "DELETE";

const err = (error: string, message: string, status: number) => NextResponse.json({ error, message }, { status });
const self = (uid: string) => ({ userId: uid, email: "account holder" });

async function me(): Promise<ClerkUserish | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const client = await clerkClient();
  return (await client.users.getUser(userId)) as unknown as ClerkUserish;
}

export async function GET() {
  const u = await me();
  if (!u) return err("unauthenticated", "Sign in first.", 401);
  const d = await getRequest(u.id);
  const closed = d ? null : await lastClosedFor(u.id);
  return NextResponse.json({
    owner: isOwnerEmailList(u.emailAddresses),
    graceDays: Math.round((await graceMs()) / 86_400_000),
    confirmWord: CONFIRM_WORD,
    request: d
      ? { status: openStatus(d), requestedAt: d.requestedAt, deleteAfter: d.deleteAfter, byYou: d.source === "user", canCancel: d.source === "user" }
      : null,
    last: closed ? { status: closed.status, closedAt: closed.closedAt } : null,
  });
}

export async function POST(req: Request) {
  const u = await me();
  if (!u) return err("unauthenticated", "Sign in first.", 401);
  const body = (await req.json().catch(() => ({}))) as { confirm?: unknown; reason?: unknown };
  if (isOwnerEmailList(u.emailAddresses)) return err("owner_protected", "The platform owner's account cannot be deleted.", 403);
  if (typeof body.confirm !== "string" || body.confirm.trim() !== CONFIRM_WORD) {
    return err("confirmation_required", `Type ${CONFIRM_WORD} to confirm.`, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  const r = await requestBySelf(u, reason);
  if (!r.ok) {
    if (r.error === "owner_protected") return err("owner_protected", "The platform owner's account cannot be deleted.", 403);
    await recordAdminAction(self(u.id), req, { action: "data.deletion.request", targetType: "user", targetId: u.id, outcome: "denied", note: "legal hold" });
    return err("refused", "Your account can't be deleted right now. Contact support for details.", 409);
  }
  if (!r.unchanged) {
    await recordAdminAction(self(u.id), req, {
      action: "data.deletion.request",
      targetType: "user",
      targetId: u.id,
      after: { source: "user", deleteAfter: new Date(r.request.deleteAfter).toISOString() },
    });
  }
  return NextResponse.json({ ok: true, request: { status: openStatus(r.request), requestedAt: r.request.requestedAt, deleteAfter: r.request.deleteAfter } });
}

export async function DELETE(req: Request) {
  const u = await me();
  if (!u) return err("unauthenticated", "Sign in first.", 401);
  const r = await cancelRequest(u.id, "user");
  if (!r.ok) {
    return r.error === "not_yours"
      ? err("not_yours", "An administrator asked for this deletion; contact support to stop it.", 403)
      : err("not_requested", "Your account is not waiting to be deleted.", 409);
  }
  await recordAdminAction(self(u.id), req, { action: "data.deletion.cancel", targetType: "user", targetId: u.id, after: { status: "cancelled", by: "user" } });
  return NextResponse.json({ ok: true });
}

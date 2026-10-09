// POST /api/admin/users/[id]/email { emailId, verified: boolean } — users:write
//
// Mark one of the account's addresses verified or unverified. Clerk's
// backend allows both (PATCH /email_addresses/{id} { verified }). An
// unverified address stops counting for anything that needs a verified one:
// owner and ADMIN_EMAILS checks, group pending-member claims, sign-in by
// that address.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { loadTargetUser, primaryEmail, targetGuard } from "@/lib/admin/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;

  const body = await readJson<{ emailId?: unknown; verified?: unknown }>(req);
  const emailId = str(body?.emailId, 80);
  if (typeof body?.verified !== "boolean") return fail("invalid_verified", "Send verified: true or false.");
  const email = (t.user.emailAddresses ?? []).find((e) => e.id === emailId);
  if (!email) return fail("not_found", "That address is not on this account.", 404);
  const was = email.verification?.status === "verified";
  if (was === body.verified) return NextResponse.json({ ok: true, unchanged: true });

  const client = await clerkClient();
  try {
    await client.emailAddresses.updateEmailAddress(emailId, { verified: body.verified });
  } catch (err) {
    const e = err as { errors?: { message?: string; longMessage?: string }[]; status?: number };
    const message = e.errors?.[0]?.longMessage || e.errors?.[0]?.message || "Clerk refused the change.";
    await recordAdminAction(actorOf(g.ctx), req, {
      action: body.verified ? "user.email.verify" : "user.email.unverify",
      targetType: "user",
      targetId: t.user.id,
      targetLabel: primaryEmail(t.user),
      before: { address: email.emailAddress, verified: was },
      outcome: "failed",
      note: message,
    });
    return fail("clerk_refused", message, 502);
  }
  await recordAdminAction(actorOf(g.ctx), req, {
    action: body.verified ? "user.email.verify" : "user.email.unverify",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    before: { address: email.emailAddress, verified: was },
    after: { address: email.emailAddress, verified: body.verified },
  });
  return NextResponse.json({ ok: true });
}

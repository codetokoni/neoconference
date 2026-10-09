// POST /api/admin/users/[id]/password — help someone who cannot sign in.
//
// Clerk's backend API cannot send Clerk's own password-reset email (the
// reset is a sign-in step the user starts: "Forgot password?" emails them a
// code). What an administrator can do, honestly labelled in the UI:
//
//   { action: "require_reset" }   Clerk marks the password compromised: the
//        next sign-in must set a new one, and every session ends now.
//        users:write and users:suspend (it signs them out).
//   { action: "clear_reset" }     undo that. users:write.
//   { action: "send_instructions" } email the account's primary address a
//        link to the sign-in page with how to reset (our mail, via Resend).
//        users:write. Nothing in it signs anyone in.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, can, refuse, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { displayName, loadTargetUser, primaryEmail, signOutEverywhere, targetGuard } from "@/lib/admin/users";
import { isMailConfigured, sendMail } from "@/lib/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function siteOrigin(req: Request): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin).replace(/\/+$/, "");
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;

  const body = await readJson<{ action?: unknown }>(req);
  const action = body?.action;
  const email = primaryEmail(t.user);
  const base = { targetType: "user", targetId: t.user.id, targetLabel: email };
  const client = await clerkClient();

  if (action === "require_reset" || action === "clear_reset") {
    if (!t.user.passwordEnabled) {
      return fail("no_password", "This account signs in without a password (a social or KingsChat sign-in, or an email code), so there is no password to reset.", 409);
    }
    if (action === "require_reset") {
      if (!can(g.ctx, "users:suspend")) return refuse("forbidden", { permission: "users:suspend" });
      const ended = await signOutEverywhere(t.user.id, () => client.users.setPasswordCompromised(t.user.id, { revokeAllSessions: true }));
      await recordAdminAction(actorOf(g.ctx), req, {
        ...base,
        action: "user.password.require_reset",
        before: { mustResetPassword: false },
        after: { mustResetPassword: true, sessionsEnded: ended },
      });
      return NextResponse.json({ ok: true, sessionsEnded: ended });
    }
    await client.users.unsetPasswordCompromised(t.user.id);
    await recordAdminAction(actorOf(g.ctx), req, {
      ...base,
      action: "user.password.clear_reset",
      before: { mustResetPassword: true },
      after: { mustResetPassword: false },
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "send_instructions") {
    if (!isMailConfigured()) return fail("mail_not_configured", "Email is not set up on this deployment (RESEND_API_KEY), so nothing can be sent.", 503);
    const verified = (t.user.emailAddresses ?? []).some((e) => e.emailAddress.toLowerCase() === email && e.verification?.status === "verified");
    if (!email || !verified) return fail("no_verified_email", "The account's primary address is not verified, so instructions are not sent to it.", 409);
    const link = `${siteOrigin(req)}/sign-in`;
    const name = displayName(t.user) || "there";
    const sent = await sendMail({
      to: email,
      subject: "Signing in to NeoConference",
      text:
        `Hi ${name},\n\nNeoConference support asked us to send you this.\n\n` +
        `To sign in, open ${link} and enter this email address.\n` +
        (t.user.passwordEnabled
          ? `If you have forgotten your password, choose "Forgot password?" and we will email you a code to set a new one.\n`
          : `Your account signs in without a password: use the same method you signed up with, or an email code if offered.\n`) +
        `\nIf you did not ask for help, you can ignore this email.\n`,
    });
    await recordAdminAction(actorOf(g.ctx), req, {
      ...base,
      action: "user.password.instructions",
      after: { sentTo: email },
      outcome: sent.ok ? "ok" : "failed",
      note: sent.ok ? undefined : sent.error,
    });
    if (!sent.ok) return fail("mail_failed", `The email was not sent: ${sent.error}.`, 502);
    return NextResponse.json({ ok: true, sentTo: email });
  }

  return fail("invalid_action", "action must be require_reset, clear_reset or send_instructions.");
}

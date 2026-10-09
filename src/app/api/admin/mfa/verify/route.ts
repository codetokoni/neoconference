// POST /api/admin/mfa/verify { code } — a 6-digit authenticator code or a
// recovery code. Starts (or refreshes) the admin session for this Clerk
// session; a fresh code also satisfies step-up for sensitive actions.
// Wrong codes are audited; five in 15 minutes lock verification.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import {
  ADMIN_SESSION_COOKIE,
  cookieOptions,
  mfaStatus,
  signAdminSession,
  verifyAdminCode,
} from "@/lib/admin/mfa";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await requireAdmin(req, null, { allowWithoutMfa: true });
  if (!g.ok) return g.response;
  const { ctx } = g;
  if (!ctx.mfa.enrolled) return fail("mfa_enrollment_required", "Set up two-factor first.", 403);
  if (!ctx.sessionId) return fail("no_session", "Sign in again.", 401);

  const body = await readJson<{ code?: unknown }>(req);
  const result = await verifyAdminCode(ctx.userId, str(body?.code, 20));
  const stepUp = ctx.mfa.verified;

  if (result === "invalid" || result === "locked" || result === "not_enrolled") {
    await recordAdminAction(actorOf(ctx), req, {
      action: result === "locked" ? "mfa.locked" : "mfa.verify.failed",
      targetType: "admin",
      targetId: ctx.userId,
      targetLabel: ctx.email,
      outcome: "denied",
    });
    if (result === "locked") {
      return fail("locked", "Too many wrong codes. Try again in 15 minutes.", 429);
    }
    return fail("invalid_code", "That code is not right. Use the newest code from your authenticator app.");
  }

  await recordAdminAction(actorOf(ctx), req, {
    action: stepUp ? "mfa.step_up" : "mfa.verify",
    targetType: "admin",
    targetId: ctx.userId,
    targetLabel: ctx.email,
    note: result === "recovery" ? "Used a recovery code." : undefined,
  });
  const now = Date.now();
  const status = await mfaStatus(ctx.userId);
  const res = NextResponse.json({
    ok: true,
    usedRecoveryCode: result === "recovery",
    recoveryLeft: status.recoveryLeft ?? 0,
  });
  res.cookies.set(
    ADMIN_SESSION_COOKIE,
    signAdminSession({ uid: ctx.userId, sid: ctx.sessionId, iat: now, stepUpAt: now }),
    cookieOptions,
  );
  return res;
}

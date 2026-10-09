// POST /api/admin/mfa/confirm { code } — finish enrollment with a code from
// the authenticator app. Returns ten recovery codes (shown once) and starts
// the admin session.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { ADMIN_SESSION_COOKIE, confirmEnrollment, cookieOptions, signAdminSession } from "@/lib/admin/mfa";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await requireAdmin(req, null, { allowWithoutMfa: true });
  if (!g.ok) return g.response;
  if (g.ctx.mfa.enrolled) return fail("already_enrolled", "Two-factor is already set up.", 409);
  if (!g.ctx.sessionId) return fail("no_session", "Sign in again.", 401);
  const body = await readJson<{ code?: unknown }>(req);
  const codes = await confirmEnrollment(g.ctx.userId, str(body?.code, 12));
  if (!codes) {
    return fail("invalid_code", "That code did not match. Check the time on your phone and try the newest code.");
  }
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "mfa.enroll",
    targetType: "admin",
    targetId: g.ctx.userId,
    targetLabel: g.ctx.email,
  });
  const now = Date.now();
  const res = NextResponse.json({ ok: true, recoveryCodes: codes });
  res.cookies.set(
    ADMIN_SESSION_COOKIE,
    signAdminSession({ uid: g.ctx.userId, sid: g.ctx.sessionId, iat: now, stepUpAt: now }),
    cookieOptions,
  );
  return res;
}

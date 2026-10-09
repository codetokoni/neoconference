// POST /api/admin/mfa/recovery — replace your recovery codes. The old ones
// stop working. Needs a fresh code (step-up).

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { regenerateRecoveryCodes } from "@/lib/admin/mfa";
import { recordAdminAction } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await requireAdmin(req, null, { stepUp: true });
  if (!g.ok) return g.response;
  const codes = await regenerateRecoveryCodes(g.ctx.userId);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "mfa.recovery_codes",
    targetType: "admin",
    targetId: g.ctx.userId,
    targetLabel: g.ctx.email,
  });
  return NextResponse.json({ ok: true, recoveryCodes: codes ?? [] });
}

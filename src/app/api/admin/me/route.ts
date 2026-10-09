// GET /api/admin/me — the signed-in administrator, their permissions and
// two-factor state. Answers before two-factor is set up so the admin area
// can show the enrollment screen.

import { NextResponse } from "next/server";
import { publicContext, requireAdmin } from "@/lib/admin/context";
import { mfaStatus } from "@/lib/admin/mfa";
import { ownerEmails, ownerSource } from "@/lib/admin/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, null, { allowWithoutMfa: true });
  if (!g.ok) return g.response;
  const mfa = await mfaStatus(g.ctx.userId);
  return NextResponse.json({
    ok: true,
    admin: publicContext(g.ctx),
    mfa,
    owner: g.ctx.isOwner ? { emails: ownerEmails(), source: ownerSource() } : null,
  });
}

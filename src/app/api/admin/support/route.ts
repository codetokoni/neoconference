// GET /api/admin/support — the signed-in administrator's open support
// session, if any, for the banner across the admin area. Any administrator.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { activeSupportSession } from "@/lib/admin/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, null);
  if (!g.ok) return g.response;
  return NextResponse.json({ session: await activeSupportSession(g.ctx.userId) });
}

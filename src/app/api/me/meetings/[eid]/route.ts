// src/app/api/me/meetings/[eid]/route.ts
//
// GET — the signed-in person's own attendance in one group meeting: when
// they joined and left, time attended, status, and who hosted. Only their
// own line; 404 for a meeting they had no part in.

import { NextResponse } from "next/server";
import { getIdentity } from "@/lib/authz";
import { myMeetingDetail } from "@/lib/groupReports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ eid: string }> }) {
  const { userId, emails } = await getIdentity();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { eid } = await ctx.params;
  const detail = await myMeetingDetail(userId, emails, eid);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ meeting: detail }, { headers: { "cache-control": "no-store" } });
}

// src/app/api/me/meetings/route.ts
//
// GET ?cursor= — the signed-in person's finished group meetings, newest
// first, with their own attendance only: duration attended and Present /
// Absent. Any member, any role; meetings of groups they have since left are
// still theirs.

import { NextResponse } from "next/server";
import { getIdentity } from "@/lib/authz";
import { listGroupsForUser } from "@/lib/groupStore";
import { listMyReports } from "@/lib/groupReports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { userId, emails } = await getIdentity();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = new URL(req.url).searchParams.get("cursor");
  const cursor = raw && /^\d{1,16}$/.test(raw) ? Number(raw) : undefined;
  const groups = cursor === undefined ? (await listGroupsForUser(userId)).map((g) => g.group.id) : [];
  const page = await listMyReports(userId, emails, groups, cursor !== undefined ? { cursor } : {});
  return NextResponse.json(page, { headers: { "cache-control": "no-store" } });
}

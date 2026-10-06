// src/app/api/groups/[id]/reports/route.ts
//
// GET ?cursor=&from=&to=  the group's finished meetings, newest first, with
// date, duration, invited, attended and absent (group:reports:view,
// Moderator and up). from / to are YYYY-MM-DD (UTC), both inclusive.

import { NextResponse } from "next/server";
import { listGroupReports, parseDay } from "@/lib/groupReports";
import { invalidBody, requireGroupPermission } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:reports:view");
  if (!gate.ok) return gate.response;

  const q = new URL(req.url).searchParams;
  const from = parseDay(q.get("from"));
  const to = parseDay(q.get("to"), true);
  if (from === null || to === null) return invalidBody("invalid_date");
  const rawCursor = q.get("cursor");
  const cursor = rawCursor && /^\d{1,16}$/.test(rawCursor) ? Number(rawCursor) : undefined;

  const page = await listGroupReports(id, gate.member.userId, {
    ...(cursor !== undefined ? { cursor } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  });
  return NextResponse.json(page, { headers: { "cache-control": "no-store" } });
}

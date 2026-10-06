// src/app/api/groups/[id]/invite/route.ts
//
// POST — mint an invite link (group:members:manage, Moderator and up). Anyone
// signed in who opens it within 72 hours joins as a Member.

import { NextResponse } from "next/server";
import { createInvite } from "@/lib/groupStore";
import { groupErrorResponse, requireGroupPermission } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:members:manage");
  if (!gate.ok) return gate.response;

  try {
    const { token, expiresAt } = await createInvite(id, gate.member.userId);
    const url = new URL(`/groups/join/${token}`, req.url).toString();
    return NextResponse.json({ ok: true, token, url, expiresAt: new Date(expiresAt).toISOString() });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

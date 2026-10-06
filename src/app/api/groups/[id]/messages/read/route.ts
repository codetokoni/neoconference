// src/app/api/groups/[id]/messages/read/route.ts
//
// POST — "I've read the chat up to now": sets this member's read marker, so
// the unread badges clear.

import { NextResponse } from "next/server";
import { markChatRead } from "@/lib/groupChat";
import { requireGroupPermission } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:read");
  if (!gate.ok) return gate.response;
  await markChatRead(id, gate.member.userId);
  return NextResponse.json({ ok: true });
}

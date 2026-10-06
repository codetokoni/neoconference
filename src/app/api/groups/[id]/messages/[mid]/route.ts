// src/app/api/groups/[id]/messages/[mid]/route.ts
//
// DELETE — remove a message: your own, or anyone's for a Moderator and up
// (group:members:manage). It stays in place as "Message removed".

import { NextResponse } from "next/server";
import { can } from "@/lib/permissions";
import { deleteMessage } from "@/lib/groupChat";
import { groupErrorResponse, requireGroupPermission } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; mid: string }> }) {
  const { id, mid } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:read");
  if (!gate.ok) return gate.response;
  try {
    const removed = await deleteMessage(id, mid, {
      userId: gate.member.userId,
      canModerate: can(gate.actor, "group:members:manage"),
    });
    return NextResponse.json({ ok: true, message: removed });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

// src/app/api/groups/[id]/route.ts
//
// GET    — the group, its members, recent activity and what the caller may do.
// PATCH  — change name, description, icon or settings (group:settings, Owner).
// DELETE — delete the group (group:delete, Owner). The body must repeat the
//          group's name: { confirmName }, the same words the screen asks for.
//
// Outside the group, every method answers 404 (src/lib/groupAuthz.ts).

import { NextResponse } from "next/server";
import { groupCapabilities, deleteGroup, listActivity, listMembers, updateGroup } from "@/lib/groupStore";
import {
  groupErrorResponse,
  invalidBody,
  readJsonObject,
  requireGroupPermission,
} from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:read");
  if (!gate.ok) return gate.response;

  const [members, activity] = await Promise.all([listMembers(id), listActivity(id, 50)]);
  return NextResponse.json(
    {
      group: gate.group,
      members,
      activity,
      me: { userId: gate.member.userId, role: gate.member.role },
      capabilities: groupCapabilities(gate.actor),
    },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:settings");
  if (!gate.ok) return gate.response;

  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  const allowed = new Set(["name", "description", "iconUrl", "settings"]);
  if (Object.keys(body).some((k) => !allowed.has(k))) return invalidBody("unknown_field");

  try {
    const group = await updateGroup(
      id,
      { name: body.name, description: body.description, iconUrl: body.iconUrl, settings: body.settings },
      gate.member.userId
    );
    return NextResponse.json({ ok: true, group });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:delete");
  if (!gate.ok) return gate.response;

  const body = await readJsonObject(req);
  if (!body || typeof body.confirmName !== "string") return invalidBody("confirmation_required");
  if (body.confirmName.trim() !== gate.group.name) return invalidBody("confirmation_mismatch");

  await deleteGroup(id);
  return NextResponse.json({ ok: true });
}

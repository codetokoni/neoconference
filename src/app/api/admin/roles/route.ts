// /api/admin/roles — administrator roles.
//
// GET  (admins:read)   built-in and custom roles, with how many admins hold each
// POST (roles:manage)  { name, description, permissions[] } create a custom role

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { cleanPermissions, listMembers, listRoles, newRoleId, saveRole } from "@/lib/admin/store";
import { recordAdminAction } from "@/lib/admin/audit";
import { beyondActor, fail, readJson, str } from "@/lib/admin/http";
import type { AdminRole } from "@/lib/admin/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "admins:read");
  if (!g.ok) return g.response;
  const [roles, members] = await Promise.all([listRoles(), listMembers()]);
  const counts = new Map<string, number>();
  for (const m of members) if (m.status !== "removed") counts.set(m.roleId, (counts.get(m.roleId) ?? 0) + 1);
  return NextResponse.json({ ok: true, roles: roles.map((r) => ({ ...r, memberCount: counts.get(r.id) ?? 0 })) });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "roles:manage");
  if (!g.ok) return g.response;
  const body = await readJson<{ name?: unknown; description?: unknown; permissions?: unknown }>(req);
  const name = str(body?.name, 60);
  if (!name) return fail("name_required", "Give the role a name.");
  const permissions = cleanPermissions(body?.permissions);
  if (!permissions.length) return fail("permissions_required", "Choose at least one permission.");
  const over = beyondActor(g.ctx, permissions);
  if (over.length) {
    return fail("role_exceeds_yours", "You cannot create a role with permissions you do not have.", 403, { permissions: over });
  }
  if ((await listRoles()).some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    return fail("name_taken", "A role with that name already exists.", 409);
  }
  const now = Date.now();
  const role: AdminRole = {
    id: newRoleId(name),
    name,
    description: str(body?.description, 300),
    permissions,
    builtIn: false,
    createdAt: now,
    updatedAt: now,
    createdBy: g.ctx.userId,
  };
  await saveRole(role);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "role.create",
    targetType: "role",
    targetId: role.id,
    targetLabel: role.name,
    after: { name: role.name, description: role.description, permissions: role.permissions },
  });
  return NextResponse.json({ ok: true, role: { ...role, memberCount: 0 } }, { status: 201 });
}

// /api/admin/roles/[id] — one custom role (roles:manage + a fresh code).
// Built-in roles cannot be changed. A change applies at once to every
// administrator holding the role.
//
// PATCH  { name?, description?, permissions? }
// DELETE only when no administrator holds it

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { cleanPermissions, deleteRole, getRole, listMembers, listRoles, saveRole } from "@/lib/admin/store";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { beyondActor, fail, readJson, str } from "@/lib/admin/http";
import type { AdminRole } from "@/lib/admin/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

const view = (r: AdminRole) => ({ name: r.name, description: r.description, permissions: [...r.permissions].sort() });

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "roles:manage");
  if (!g.ok) return g.response;
  const role = await getRole(params.id);
  if (!role) return fail("not_found", "That role was not found.", 404);
  if (role.builtIn) return fail("built_in", "Built-in roles cannot be changed. Create a custom role instead.", 400);
  if (beyondActor(g.ctx, role.permissions).length) {
    return fail("outranks_you", "This role has permissions you do not have, so only the owner can change it.", 403);
  }

  const body = await readJson<{ name?: unknown; description?: unknown; permissions?: unknown }>(req);
  const next: AdminRole = { ...role, updatedAt: Date.now() };
  if (body?.name !== undefined) {
    const name = str(body.name, 60);
    if (!name) return fail("name_required", "Give the role a name.");
    if ((await listRoles()).some((r) => r.id !== role.id && r.name.toLowerCase() === name.toLowerCase())) {
      return fail("name_taken", "A role with that name already exists.", 409);
    }
    next.name = name;
  }
  if (body?.description !== undefined) next.description = str(body.description, 300);
  if (body?.permissions !== undefined) {
    const permissions = cleanPermissions(body.permissions);
    if (!permissions.length) return fail("permissions_required", "Choose at least one permission.");
    const over = beyondActor(g.ctx, permissions);
    if (over.length) {
      return fail("role_exceeds_yours", "You cannot give a role permissions you do not have.", 403, { permissions: over });
    }
    next.permissions = permissions;
  }

  const change = diff(view(role), view(next));
  if (!Object.keys(change.after).length) return NextResponse.json({ ok: true, role, unchanged: true });
  await saveRole(next);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "role.update",
    targetType: "role",
    targetId: role.id,
    targetLabel: next.name,
    ...change,
  });
  return NextResponse.json({ ok: true, role: next });
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "roles:manage");
  if (!g.ok) return g.response;
  const role = await getRole(params.id);
  if (!role) return fail("not_found", "That role was not found.", 404);
  if (role.builtIn) return fail("built_in", "Built-in roles cannot be deleted.", 400);
  if (beyondActor(g.ctx, role.permissions).length) {
    return fail("outranks_you", "This role has permissions you do not have, so only the owner can delete it.", 403);
  }
  const holders = (await listMembers()).filter((m) => m.roleId === role.id && m.status !== "removed");
  if (holders.length) {
    return fail("role_in_use", `${holders.length} administrator(s) hold this role. Give them another role first.`, 409, {
      holders: holders.map((h) => h.email),
    });
  }
  await deleteRole(role.id);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "role.delete",
    targetType: "role",
    targetId: role.id,
    targetLabel: role.name,
    before: view(role),
  });
  return NextResponse.json({ ok: true });
}

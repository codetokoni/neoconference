import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { isRole, readRoleFromMetadata, type Role } from "@/lib/roles";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { isOwnerEmailList } from "@/lib/admin/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/role
 * Body: { userId: string; role: "staff" | "user" }
 * Sets a user's app role (staff runs video rooms). Making someone an
 * administrator is done on the Administrators page, which gives them a
 * role with defined permissions — not here.
 */
export async function POST(req: Request) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;

  let body: { userId?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const targetId = typeof body.userId === "string" ? body.userId.trim() : "";
  const newRole = body.role;
  if (!targetId) {
    return NextResponse.json({ error: "missing_userId" }, { status: 400 });
  }
  if (!isRole(newRole)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }
  if (newRole === "admin") {
    return NextResponse.json(
      { error: "use_administrators_page", message: "Appoint administrators on the Administrators page." },
      { status: 400 },
    );
  }
  if (targetId === g.ctx.userId) {
    return NextResponse.json({ error: "cannot_change_self" }, { status: 400 });
  }

  const client = await clerkClient();
  const target = await client.users.getUser(targetId);
  if (isOwnerEmailList(target.emailAddresses)) {
    return NextResponse.json({ error: "owner_protected", message: "The platform owner's role cannot be changed." }, { status: 403 });
  }
  const before = readRoleFromMetadata(target.publicMetadata);
  await client.users.updateUserMetadata(targetId, {
    publicMetadata: { ...(target.publicMetadata ?? {}), role: newRole as Role },
  });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.role",
    targetType: "user",
    targetId,
    targetLabel: target.emailAddresses?.[0]?.emailAddress ?? targetId,
    before: { role: before },
    after: { role: newRole },
  });

  return NextResponse.json({ ok: true, userId: targetId, role: newRole });
}

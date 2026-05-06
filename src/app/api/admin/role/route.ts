import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireRole, isRole, type Role } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/role
 * Body: { userId: string; role: "admin" | "staff" | "user" }
 * Only admins may call this. Updates target user's publicMetadata.role.
 */
export async function POST(req: Request) {
  const caller = await requireRole(["admin"]);
  if (!caller) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

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

  // Prevent admin from accidentally demoting themselves and being locked out.
  if (targetId === caller.userId && newRole !== "admin") {
    return NextResponse.json(
      { error: "cannot_demote_self" },
      { status: 400 }
    );
  }

  const client = await clerkClient();
  const target = await client.users.getUser(targetId);
  await client.users.updateUserMetadata(targetId, {
    publicMetadata: { ...(target.publicMetadata ?? {}), role: newRole as Role },
  });

  return NextResponse.json({ ok: true, userId: targetId, role: newRole });
}

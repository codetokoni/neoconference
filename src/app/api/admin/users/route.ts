import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { readRoleFromMetadata } from "@/lib/roles";
import { requireAdmin } from "@/lib/admin/context";
import { isOwnerEmailList } from "@/lib/admin/owner";
import { listMembers } from "@/lib/admin/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users?limit=50&offset=0&query=
 * Lists Clerk users with their current role for the admin panel.
 * Only admins may call this.
 */
export async function GET(req: Request) {
  const g = await requireAdmin(req, "users:read");
  if (!g.ok) return g.response;

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1),
    100
  );
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);
  const query = url.searchParams.get("query")?.trim() || undefined;

  const client = await clerkClient();
  const list = await client.users.getUserList({
    limit,
    offset,
    query,
  });

  // Platform access comes from the owner list and administrator records,
  // not the Clerk role, so say which applies.
  const members = new Map((await listMembers()).map((m) => [m.userId, m]));
  const items = list.data.map((u) => {
    const m = members.get(u.id);
    return {
      id: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "",
      email: u.emailAddresses?.[0]?.emailAddress ?? "",
      imageUrl: u.imageUrl,
      role: readRoleFromMetadata(u.publicMetadata),
      access: isOwnerEmailList(u.emailAddresses)
        ? "owner"
        : m && m.status !== "removed"
          ? m.status === "suspended"
            ? "admin (suspended)"
            : "admin"
          : null,
    };
  });

  return NextResponse.json({ items, total: list.totalCount });
}

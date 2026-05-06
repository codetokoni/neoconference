import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireRole, readRoleFromMetadata } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users?limit=50&offset=0&query=
 * Lists Clerk users with their current role for the admin panel.
 * Only admins may call this.
 */
export async function GET(req: Request) {
  const caller = await requireRole(["admin"]);
  if (!caller) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

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

  const items = list.data.map((u) => ({
    id: u.id,
    name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "",
    email: u.emailAddresses?.[0]?.emailAddress ?? "",
    imageUrl: u.imageUrl,
    role: readRoleFromMetadata(u.publicMetadata),
  }));

  return NextResponse.json({ items, total: list.totalCount });
}

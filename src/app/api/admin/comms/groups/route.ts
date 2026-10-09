// /api/admin/comms/groups — find groups to send to (notifications:send).
//
// GET ?q=   groups whose name or id matches, from the platform-wide group
//           index (src/lib/admin/groups.ts), at most 50: id, name, owner and
//           member count. Its own route so a communications role does not
//           need users:read to pick an audience.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { listAllGroups } from "@/lib/admin/groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const { groups } = await listAllGroups();
  const items = groups
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.id.toLowerCase() === q)
    .slice(0, 50)
    .map((r) => ({ id: r.id, name: r.name, ownerName: r.ownerName, memberCount: r.memberCount }));
  return NextResponse.json({ items, total: groups.length }, { headers: { "cache-control": "no-store" } });
}

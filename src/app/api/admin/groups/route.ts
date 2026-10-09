// /api/admin/groups — every group on the platform.
//
// GET  ?q=&page=&pageSize=   users:read. Searches name, description, id and
//      the owner's name or email.
// POST { action: "backfill" } users:write. Rebuild the group index from the
//      per-user group sets (groups made before the index existed). Safe to
//      repeat: it only adds ids that still resolve to a group.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { listAllGroups } from "@/lib/admin/groups";
import { backfillGroupIndex } from "@/lib/groupStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "users:read");
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const q = (p.get("q") ?? "").trim().toLowerCase();
  const pageSize = Math.min(Math.max(parseInt(p.get("pageSize") ?? "25", 10) || 25, 10), 100);
  const page = Math.max(parseInt(p.get("page") ?? "1", 10) || 1, 1);
  const { groups, backfilledAt, backfilled } = await listAllGroups();
  const matches = q
    ? groups.filter((r) => [r.id, r.name, r.description, r.ownerName ?? "", r.ownerEmail ?? "", r.ownerId ?? ""].join(" ").toLowerCase().includes(q))
    : groups;
  return NextResponse.json({
    items: matches.slice((page - 1) * pageSize, page * pageSize),
    total: matches.length,
    page,
    pageSize,
    backfilledAt,
    backfilled,
  });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;
  const body = await readJson<{ action?: unknown }>(req);
  if (body?.action !== "backfill") return fail("invalid_action", 'action must be "backfill".');
  const result = await backfillGroupIndex();
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "group.index.backfill",
    targetType: "group",
    after: result,
  });
  return NextResponse.json({ ok: true, ...result });
}

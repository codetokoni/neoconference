// GET /api/admin/groups/[gid] — one group: owner, members, people invited
// before they had an account, and its history. users:read.
//
// (Invite links are not listed: they are stored by token only and expire
// after 72 hours, so there is no per-group list of them to read.)

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import { groupRow } from "@/lib/admin/groups";
import { getGroup, listActivity, listMembers, listPendingMembers } from "@/lib/groupStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { gid: string } }) {
  const g = await requireAdmin(req, "users:read");
  if (!g.ok) return g.response;
  const group = await getGroup(params.gid);
  if (!group) return fail("not_found", "No such group.", 404);
  const [row, members, pending, activity] = await Promise.all([
    groupRow(group),
    listMembers(group.id),
    listPendingMembers(group.id),
    listActivity(group.id, 50),
  ]);
  return NextResponse.json({ group: row, settings: group.settings, members, pending, activity });
}

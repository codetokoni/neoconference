// PUT /api/admin/users/[id]/tags { tags: string[] } — internal tags, the
// whole set. users:write. Lower-case letters, digits, - and _; up to 20.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { readJson } from "@/lib/admin/http";
import { cleanTags, getTags, loadTargetUser, primaryEmail, setTags, targetGuard } from "@/lib/admin/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  const body = await readJson<{ tags?: unknown }>(req);
  const tags = cleanTags(body?.tags);
  const before = await getTags(t.user.id);
  const change = diff({ tags: before }, { tags });
  if (!Object.keys(change.after).length) return NextResponse.json({ ok: true, tags, unchanged: true });
  await setTags(t.user.id, tags);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.tags",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    ...change,
  });
  return NextResponse.json({ ok: true, tags });
}

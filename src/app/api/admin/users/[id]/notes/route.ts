// /api/admin/users/[id]/notes — internal support notes. users:write.
// Only administrators see them; the user never does.
//
// POST   { text }       add a note
// DELETE ?noteId=…      remove one (the audit entry keeps what it said)

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { addNote, loadTargetUser, primaryEmail, removeNote, targetGuard } from "@/lib/admin/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  const body = await readJson<{ text?: unknown }>(req);
  const text = str(body?.text, 2000);
  if (!text) return fail("empty_note", "Write the note first.");
  const note = await addNote(t.user.id, { byId: g.ctx.userId, byEmail: g.ctx.email, text });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.note.add",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    after: { noteId: note.id, text },
  });
  return NextResponse.json({ ok: true, note }, { status: 201 });
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;
  const noteId = new URL(req.url).searchParams.get("noteId") ?? "";
  const gone = await removeNote(t.user.id, noteId);
  if (!gone) return fail("not_found", "That note was not found.", 404);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.note.remove",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    before: { noteId: gone.id, text: gone.text, by: gone.byEmail },
  });
  return NextResponse.json({ ok: true });
}

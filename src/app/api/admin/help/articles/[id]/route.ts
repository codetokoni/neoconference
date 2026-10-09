// /api/admin/help/articles/[id]
// GET    (support:read)   one article
// PATCH  (support:write)  any of { title, summary, body, category, kind, tags, status, slug }
// DELETE (support:write)
// Every change is audited with the fields before and after.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { articleFields, auditView } from "@/lib/support/articleInput";
import { deleteArticle, getArticle, listArticles, saveArticle, uniqueSlug } from "@/lib/support/help";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "support:read");
  if (!g.ok) return g.response;
  const a = await getArticle(params.id);
  if (!a) return fail("not_found", "No article with that id.", 404);
  return NextResponse.json({ ok: true, article: a });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "support:write");
  if (!g.ok) return g.response;
  const current = await getArticle(params.id);
  if (!current) return fail("not_found", "No article with that id.", 404);
  const f = articleFields(await readJson(req), current);
  if (!f.ok) return fail(f.error, f.message);
  const now = Date.now();
  const next = {
    ...current,
    ...f.value,
    slug: f.value.slug === current.slug ? current.slug : uniqueSlug(f.value.slug || f.value.title, await listArticles(), current.id),
  };
  const d = diff(auditView(current), auditView(next));
  if (!Object.keys(d.after).length) return NextResponse.json({ ok: true, changed: false, article: current });
  next.updatedAt = now;
  next.updatedBy = g.ctx.email;
  if (next.status === "published" && current.status !== "published") next.publishedAt = now;
  await saveArticle(next);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: current.status !== next.status ? (next.status === "published" ? "help.article.publish" : "help.article.unpublish") : "help.article.update",
    targetType: "help_article",
    targetId: next.id,
    targetLabel: next.title,
    ...d,
  });
  return NextResponse.json({ ok: true, changed: true, article: next });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "support:write");
  if (!g.ok) return g.response;
  const a = await getArticle(params.id);
  if (!a) return fail("not_found", "No article with that id.", 404);
  await deleteArticle(a.id);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "help.article.delete",
    targetType: "help_article",
    targetId: a.id,
    targetLabel: a.title,
    before: auditView(a),
  });
  return NextResponse.json({ ok: true });
}

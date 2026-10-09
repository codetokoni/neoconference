// /api/admin/help/articles — the help centre's articles, FAQs and guides.
// GET  (support:read)   every article, drafts included
// POST (support:write)  { title, summary?, body, category, kind?, tags?, status?, slug? }

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { articleFields, auditView } from "@/lib/support/articleInput";
import { listArticles, saveArticle, uniqueSlug } from "@/lib/support/help";
import { newId } from "@/lib/support/tickets";
import type { HelpArticle } from "@/lib/support/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "support:read");
  if (!g.ok) return g.response;
  return NextResponse.json({ ok: true, articles: await listArticles() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "support:write");
  if (!g.ok) return g.response;
  const b = await readJson(req);
  const f = articleFields(b, null);
  if (!f.ok) return fail(f.error, f.message);
  const all = await listArticles();
  const now = Date.now();
  const a: HelpArticle = {
    id: newId(),
    ...f.value,
    slug: uniqueSlug(f.value.slug || f.value.title, all),
    createdAt: now,
    updatedAt: now,
    publishedAt: f.value.status === "published" ? now : null,
    createdBy: g.ctx.email,
    updatedBy: g.ctx.email,
  };
  await saveArticle(a);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "help.article.create",
    targetType: "help_article",
    targetId: a.id,
    targetLabel: a.title,
    after: auditView(a),
  });
  return NextResponse.json({ ok: true, article: a }, { status: 201 });
}

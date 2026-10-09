"use client";

// src/app/admin/help/help-client.tsx — the help centre's articles, drafts included.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { HELP_CATEGORIES, HELP_KIND_LABEL, helpCategoryLabel, type HelpArticle } from "@/lib/support/model";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";

export default function HelpClient() {
  const { can, adminFetch } = useAdmin();
  const [articles, setArticles] = useState<HelpArticle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");

  useEffect(() => {
    adminFetch<{ articles: HelpArticle[] }>("/api/admin/help/articles").then((r) => {
      if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
      setArticles(r.data.articles);
    });
  }, [adminFetch]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (articles ?? []).filter(
      (a) =>
        (!status || a.status === status) &&
        (!category || a.category === category) &&
        (!needle || `${a.title} ${a.summary} ${a.tags.join(" ")} ${a.slug}`.toLowerCase().includes(needle)),
    );
  }, [articles, q, status, category]);

  return (
    <div>
      <PageHeader
        title="Help centre"
        sub={
          <>
            Articles, FAQs and troubleshooting guides. Published ones appear at{" "}
            <a href="/help" target="_blank" className="text-cyan-300">
              /help
            </a>{" "}
            and as suggestions on the contact form; drafts stay here.
          </>
        }
        actions={
          can("support:write") && (
            <Link href="/admin/help/new" className={btn.primary}>
              New article
            </Link>
          )
        }
      />
      {error && <Notice kind="err">{error}</Notice>}
      <div className="mb-3 flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, summaries, tags" aria-label="Search articles" className={`${field} max-w-xs`} />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={`${field} w-auto`}>
          <option value="">Any status</option>
          <option value="published">Published</option>
          <option value="draft">Draft</option>
        </select>
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className={`${field} w-auto`}>
          <option value="">Any category</option>
          {HELP_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {!articles ? (
        error ? null : <Loading />
      ) : shown.length === 0 ? (
        <Empty>{articles.length ? "No articles match." : "No articles yet."}</Empty>
      ) : (
        <Panel className="p-0">
          <ul className="divide-y divide-white/5">
            {shown.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/admin/help/${a.id}`} className="font-medium text-zinc-100 hover:text-cyan-200">
                    {a.title}
                  </Link>
                  <p className="truncate text-xs text-zinc-500">
                    /help/{a.slug} · {helpCategoryLabel(a.category)} · {HELP_KIND_LABEL[a.kind]} · updated {fmtTime(a.updatedAt)} by {a.updatedBy}
                  </p>
                </div>
                <Badge tone={a.status === "published" ? "green" : "zinc"}>{a.status === "published" ? "Published" : "Draft"}</Badge>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

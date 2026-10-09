"use client";

// src/app/admin/help/help-client.tsx — the help centre's articles, drafts included.
// The filters live in the address bar so a filtered list can be linked.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HELP_CATEGORIES, HELP_KIND_LABEL, helpCategoryLabel, type HelpArticle } from "@/lib/support/model";
import { Time, errorText, useAdmin } from "../AdminApi";
import { Badge, Empty, FilterBar, Labeled, LoadState, PageHeader, Pager, SortTh, TableWrap, btn, field, useClientTable, useUrlFilters } from "../ui";

const URL_DEFAULTS = { q: "", status: "", category: "" };

export default function HelpClient() {
  const { can, adminFetch } = useAdmin();
  const f = useUrlFilters(URL_DEFAULTS);
  const { status, category } = f.value;
  const [articles, setArticles] = useState<HelpArticle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The search box filters as you type; the address bar catches up a moment later.
  const [q, setQ] = useState(f.value.q);
  const written = useRef(f.value.q);
  useEffect(() => {
    if (f.value.q !== written.current) {
      written.current = f.value.q;
      setQ(f.value.q);
    }
  }, [f.value.q]);
  const { set } = f;
  useEffect(() => {
    if (q === written.current) return;
    const t = setTimeout(() => {
      written.current = q;
      set({ q });
    }, 400);
    return () => clearTimeout(t);
  }, [q, set]);

  const load = useCallback(async () => {
    setError(null);
    const r = await adminFetch<{ articles: HelpArticle[] }>("/api/admin/help/articles");
    if (!r.ok) return setError(errorText(r));
    setArticles(r.data.articles);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (articles ?? []).filter(
      (a) =>
        (!status || a.status === status) &&
        (!category || a.category === category) &&
        (!needle || `${a.title} ${a.summary} ${a.tags.join(" ")} ${a.slug}`.toLowerCase().includes(needle)),
    );
  }, [articles, q, status, category]);
  const table = useClientTable(
    shown,
    (a, k) => (k === "title" ? a.title : k === "category" ? helpCategoryLabel(a.category) : k === "kind" ? HELP_KIND_LABEL[a.kind] : k === "status" ? a.status : a.updatedAt),
    { key: "updated", dir: "desc" },
  );
  const filtered = !!(q.trim() || status || category);

  return (
    <div>
      <PageHeader
        title="Help centre"
        sub={
          <>
            Articles, FAQs and troubleshooting guides. Published ones appear at{" "}
            <a href="/help" target="_blank" rel="noopener noreferrer" className="text-cyan-300">
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
      <FilterBar
        active={filtered}
        onClear={() => {
          written.current = "";
          setQ("");
          f.reset();
        }}
      >
        <Labeled label="Search" className="min-w-[12rem] flex-1 sm:max-w-xs">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titles, summaries, tags" className={field} />
        </Labeled>
        <Labeled label="Status">
          <select value={status} onChange={(e) => f.set({ status: e.target.value })} className={`${field} sm:w-48`}>
            <option value="">Any status</option>
            <option value="published">Published</option>
            <option value="draft">Draft</option>
          </select>
        </Labeled>
        <Labeled label="Category">
          <select value={category} onChange={(e) => f.set({ category: e.target.value })} className={`${field} sm:w-48`}>
            <option value="">Any category</option>
            {HELP_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </Labeled>
      </FilterBar>
      <LoadState data={articles} error={error} onRetry={load} empty="No articles yet.">
        {() =>
          shown.length === 0 ? (
            <Empty>No articles match.</Empty>
          ) : (
            <>
              <TableWrap minWidth={720}>
                <thead className="border-b border-white/10 text-xs text-zinc-400">
                  <tr>
                    <SortTh label="Article" k="title" sort={table.sort} onSort={table.onSort} />
                    <SortTh label="Category" k="category" sort={table.sort} onSort={table.onSort} />
                    <SortTh label="Type" k="kind" sort={table.sort} onSort={table.onSort} />
                    <SortTh label="Status" k="status" sort={table.sort} onSort={table.onSort} />
                    <SortTh label="Updated" k="updated" sort={table.sort} onSort={table.onSort} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {table.visible.map((a) => (
                    <tr key={a.id}>
                      <td className="max-w-[22rem] px-3 py-2.5">
                        <Link href={`/admin/help/${a.id}`} className="block truncate font-medium text-zinc-100 hover:text-cyan-200">
                          {a.title}
                        </Link>
                        <span className="block truncate text-xs text-zinc-400">/help/{a.slug}</span>
                      </td>
                      <td className="px-3 py-2.5 text-zinc-300">{helpCategoryLabel(a.category)}</td>
                      <td className="px-3 py-2.5 text-zinc-300">{HELP_KIND_LABEL[a.kind]}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={a.status === "published" ? "green" : "zinc"}>{a.status === "published" ? "Published" : "Draft"}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-zinc-400">
                        <Time ts={a.updatedAt} mode="date" />
                        <span className="block truncate text-zinc-400">by {a.updatedBy}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
              <Pager page={table.page} pageSize={table.pageSize} total={table.total} onPage={table.setPage} onPageSize={table.setPageSize} noun="article" />
            </>
          )
        }
      </LoadState>
    </div>
  );
}

"use client";

// src/app/admin/help/[id]/article-editor.tsx — write or edit a help article,
// with a preview drawn exactly as /help draws it.

import Link from "next/link";
import { useEffect, useState } from "react";
import ArticleBody from "@/components/help/ArticleBody";
import { HELP_CATEGORIES, HELP_KINDS, HELP_KIND_LABEL, type HelpArticle } from "@/lib/support/model";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Confirm, Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";

type Draft = { title: string; summary: string; body: string; category: string; kind: string; tags: string; slug: string };
const EMPTY: Draft = { title: "", summary: "", body: "", category: "getting-started", kind: "article", tags: "", slug: "" };

export default function ArticleEditor({ id }: { id: string | null }) {
  const { can, adminFetch } = useAdmin();
  const write = can("support:write");
  const [article, setArticle] = useState<HelpArticle | null>(null);
  const [draft, setDraft] = useState<Draft | null>(id ? null : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");

  useEffect(() => {
    if (!id) return;
    adminFetch<{ article: HelpArticle }>(`/api/admin/help/articles/${encodeURIComponent(id)}`).then((r) => {
      if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
      const a = r.data.article;
      setArticle(a);
      setDraft({ title: a.title, summary: a.summary, body: a.body, category: a.category, kind: a.kind, tags: a.tags.join(", "), slug: a.slug });
    });
  }, [adminFetch, id]);

  const save = async (status?: "draft" | "published") => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const json = { ...draft, tags: draft.tags.split(",").map((x) => x.trim()).filter(Boolean), ...(status ? { status } : {}) };
    const r = article
      ? await adminFetch<{ article: HelpArticle; changed: boolean }>(`/api/admin/help/articles/${article.id}`, { method: "PATCH", json })
      : await adminFetch<{ article: HelpArticle }>("/api/admin/help/articles", { method: "POST", json });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
    const a = r.data.article;
    if (!article) {
      window.location.href = `/admin/help/${a.id}`;
      return;
    }
    setArticle(a);
    setDraft((d) => (d ? { ...d, slug: a.slug } : d));
    setOk(status === "published" ? "Published. It is live at /help." : status === "draft" ? "Unpublished. It is hidden from /help." : "Saved.");
  };

  const remove = async () => {
    if (!article) return;
    const r = await adminFetch(`/api/admin/help/articles/${article.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
    window.location.href = "/admin/help";
  };

  if (!draft) return error ? <Notice kind="err">{error}</Notice> : <Loading />;
  const up = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });
  const published = article?.status === "published";

  return (
    <div>
      <Link href="/admin/help" className="text-sm text-cyan-300 hover:text-cyan-200">
        ← Help centre
      </Link>
      <PageHeader
        title={article ? "Edit article" : "New article"}
        sub={
          article ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge tone={published ? "green" : "zinc"}>{published ? "Published" : "Draft"}</Badge>
              {published ? (
                <a href={`/help/${article.slug}`} target="_blank" className="text-cyan-300">
                  /help/{article.slug}
                </a>
              ) : (
                <span>/help/{article.slug} once published</span>
              )}
              <span>· updated {fmtTime(article.updatedAt)} by {article.updatedBy}</span>
            </span>
          ) : (
            "Saved as a draft first; publish it when it is ready."
          )
        }
        actions={
          write && (
            <>
              {article && (
                <button type="button" className={btn.danger} onClick={() => setDeleting(true)}>
                  Delete
                </button>
              )}
              <button type="button" disabled={busy} className={btn.ghost} onClick={() => save()}>
                {article ? "Save" : "Save draft"}
              </button>
              {article && (
                <button type="button" disabled={busy} className={published ? btn.warn : btn.primary} onClick={() => save(published ? "draft" : "published")}>
                  {published ? "Unpublish" : "Publish"}
                </button>
              )}
            </>
          )
        }
      />
      {error && <Notice kind="err" onClose={() => setError(null)}>{error}</Notice>}
      {ok && <Notice kind="ok" onClose={() => setOk(null)}>{ok}</Notice>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Panel>
          <label className="block text-xs text-zinc-400">
            Title
            <input disabled={!write} value={draft.title} onChange={up("title")} maxLength={160} className={`${field} mt-1 text-base`} />
          </label>
          <label className="mt-3 block text-xs text-zinc-400">
            Summary (shown in lists, search results and to search engines)
            <input disabled={!write} value={draft.summary} onChange={up("summary")} maxLength={300} className={`${field} mt-1`} />
          </label>
          <div role="tablist" aria-label="Write or preview" className="mt-3 flex gap-1">
            {(["write", "preview"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? "bg-cyan-400/15 text-cyan-100" : "text-zinc-400 hover:bg-white/5"}`}>
                {k === "write" ? "Write" : "Preview"}
              </button>
            ))}
          </div>
          {tab === "write" ? (
            <textarea
              aria-label="Article body"
              disabled={!write}
              value={draft.body}
              onChange={up("body")}
              rows={18}
              placeholder={"## A heading\nA paragraph with **bold**, `code` and a [link](/pricing).\n\n- a list item\n1. a numbered step"}
              className={`${field} mt-2 font-mono text-[13px]`}
            />
          ) : (
            <div className="mt-2 rounded-lg border border-white/10 bg-[#050a14] p-4">
              <h1 className="mb-2 text-2xl font-semibold text-white">{draft.title || "Untitled"}</h1>
              {draft.summary && <p className="mb-4 text-cyan-100/80">{draft.summary}</p>}
              <ArticleBody body={draft.body} />
            </div>
          )}
        </Panel>
        <Panel className="space-y-3 self-start">
          <label className="block text-xs text-zinc-400">
            Category
            <select disabled={!write} value={draft.category} onChange={up("category")} className={`${field} mt-1`}>
              {HELP_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-zinc-400">
            Type
            <select disabled={!write} value={draft.kind} onChange={up("kind")} className={`${field} mt-1`}>
              {HELP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {HELP_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-zinc-400">
            Tags (help the contact form suggest it)
            <input disabled={!write} value={draft.tags} onChange={up("tags")} placeholder="recording, library" className={`${field} mt-1`} />
          </label>
          <label className="block text-xs text-zinc-400">
            Address
            <span className="mt-1 flex items-center gap-1 text-sm text-zinc-500">
              /help/
              <input disabled={!write} value={draft.slug} onChange={up("slug")} placeholder="from the title" className={field} />
            </span>
          </label>
        </Panel>
      </div>

      {deleting && article && (
        <Confirm
          title="Delete this article?"
          body={<>“{article.title}” will be removed{published ? " from /help" : ""}. The audit log keeps a copy of its text.</>}
          confirmLabel="Delete"
          danger
          onConfirm={remove}
          onCancel={() => setDeleting(false)}
        />
      )}
    </div>
  );
}

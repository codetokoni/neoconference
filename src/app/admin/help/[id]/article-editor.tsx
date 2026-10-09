"use client";

// src/app/admin/help/[id]/article-editor.tsx — write or edit a help article,
// with a preview drawn exactly as /help draws it.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import ArticleBody from "@/components/help/ArticleBody";
import { HELP_CATEGORIES, HELP_KINDS, HELP_KIND_LABEL, type HelpArticle } from "@/lib/support/model";
import { errorText, fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Confirm, LoadState, Notice, PageHeader, Panel, TabPanel, Tabs, btn, field } from "../../ui";

type Draft = { title: string; summary: string; body: string; category: string; kind: string; tags: string; slug: string };
const EMPTY: Draft = { title: "", summary: "", body: "", category: "getting-started", kind: "article", tags: "", slug: "" };
const TABS = [
  { id: "write", label: "Write" },
  { id: "preview", label: "Preview" },
] as const;
type Ask = "publish" | "unpublish" | "save-slug" | "delete" | "leave";

function draftOf(a: HelpArticle): Draft {
  return { title: a.title, summary: a.summary, body: a.body, category: a.category, kind: a.kind, tags: a.tags.join(", "), slug: a.slug };
}

function same(a: Draft, b: Draft): boolean {
  return (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k]);
}

export default function ArticleEditor({ id }: { id: string | null }) {
  const { can, adminFetch } = useAdmin();
  const router = useRouter();
  const write = can("support:write");
  const [article, setArticle] = useState<HelpArticle | null>(null);
  const [draft, setDraft] = useState<Draft | null>(id ? null : EMPTY);
  const [saved, setSaved] = useState<Draft>(EMPTY);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Ask | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");

  const load = useCallback(async () => {
    if (!id) return;
    setLoadErr(null);
    const r = await adminFetch<{ article: HelpArticle }>(`/api/admin/help/articles/${encodeURIComponent(id)}`);
    if (!r.ok) return setLoadErr(errorText(r));
    const a = r.data.article;
    setArticle(a);
    setDraft(draftOf(a));
    setSaved(draftOf(a));
  }, [adminFetch, id]);
  useEffect(() => {
    load();
  }, [load]);

  const dirty = !!draft && write && !same(draft, saved);
  // Unsaved writing is not lost to a closed tab or a reload without asking.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async (status?: "draft" | "published") => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setOk(null);
    const json = { ...draft, tags: draft.tags.split(",").map((x) => x.trim()).filter(Boolean), ...(status ? { status } : {}) };
    const r = article
      ? await adminFetch<{ article: HelpArticle; changed: boolean }>(`/api/admin/help/articles/${article.id}`, { method: "PATCH", json })
      : await adminFetch<{ article: HelpArticle }>("/api/admin/help/articles", { method: "POST", json });
    setAsking(null);
    if (!r.ok) {
      setBusy(false);
      return setError(errorText(r));
    }
    const a = r.data.article;
    if (!article) {
      // Stays busy until the new article's own page takes over.
      setSaved(draft);
      router.push(`/admin/help/${a.id}`);
      return;
    }
    setBusy(false);
    setArticle(a);
    const next = { ...draft, slug: a.slug };
    setDraft(next);
    setSaved(next);
    setOk(status === "published" ? "Published. It is live at /help." : status === "draft" ? "Unpublished. It is hidden from /help." : "Saved.");
  };

  const remove = async () => {
    if (!article) return;
    setError(null);
    setOk(null);
    const r = await adminFetch(`/api/admin/help/articles/${article.id}`, { method: "DELETE" });
    if (!r.ok) {
      setAsking(null);
      return setError(errorText(r));
    }
    setSaved(draft ?? EMPTY);
    router.push("/admin/help");
  };

  const back = (
    <Link
      href="/admin/help"
      onClick={(e) => {
        if (!dirty) return;
        e.preventDefault();
        setAsking("leave");
      }}
      className="text-sm text-cyan-300 hover:text-cyan-200"
    >
      ← Help centre
    </Link>
  );
  if (!draft)
    return (
      <div className="space-y-3">
        {back}
        <LoadState data={null} error={loadErr} onRetry={load}>
          {() => null}
        </LoadState>
      </div>
    );
  const up = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });
  const published = article?.status === "published";
  // A published article's address is in links people already have.
  const slugMoved = !!article && published && draft.slug.trim() !== article.slug;

  return (
    <div>
      {back}
      <PageHeader
        title={article ? "Edit article" : "New article"}
        sub={
          article ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge tone={published ? "green" : "zinc"}>{published ? "Published" : "Draft"}</Badge>
              {published ? (
                <a href={`/help/${article.slug}`} target="_blank" rel="noopener noreferrer" className="break-all text-cyan-300">
                  /help/{article.slug}
                </a>
              ) : (
                <span className="break-all">/help/{article.slug} once published</span>
              )}
              <span>· updated {fmtTime(article.updatedAt)} by {article.updatedBy}</span>
              {dirty && <Badge tone="amber">unsaved changes</Badge>}
            </span>
          ) : (
            "Saved as a draft first; publish it when it is ready."
          )
        }
        actions={
          write && (
            <>
              {article && (
                <button type="button" className={btn.danger} disabled={busy} onClick={() => setAsking("delete")}>
                  Delete
                </button>
              )}
              <button type="button" disabled={busy} className={btn.ghost} onClick={() => (slugMoved ? setAsking("save-slug") : save())}>
                {busy && !asking ? "Saving…" : article ? "Save" : "Save draft"}
              </button>
              {article && (
                <button type="button" disabled={busy} className={published ? btn.warn : btn.primary} onClick={() => setAsking(published ? "unpublish" : "publish")}>
                  {published ? "Unpublish" : "Publish"}
                </button>
              )}
            </>
          )
        }
      />
      {!write && <Notice kind="info">You can read articles here; writing and publishing them needs the support:write permission.</Notice>}
      {error && (
        <Notice kind="err" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
      {ok && (
        <Notice kind="ok" onClose={() => setOk(null)}>
          {ok}
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Panel className="min-w-0">
          <label className="block text-xs text-zinc-400">
            Title
            <input disabled={!write} value={draft.title} onChange={up("title")} maxLength={160} className={`${field} mt-1 text-base`} />
          </label>
          <label className="mt-3 block text-xs text-zinc-400">
            Summary (shown in lists, search results and to search engines)
            <input disabled={!write} value={draft.summary} onChange={up("summary")} maxLength={300} className={`${field} mt-1`} />
          </label>
          <div className="mt-3">
            <Tabs label="Write or preview" tabs={TABS} value={tab} onChange={setTab} idBase="article" />
          </div>
          <TabPanel idBase="article" value={tab}>
            {tab === "write" ? (
              <textarea
                aria-label="Article body"
                disabled={!write}
                value={draft.body}
                onChange={up("body")}
                rows={18}
                placeholder={"## A heading\nA paragraph with **bold**, `code` and a [link](/pricing).\n\n- a list item\n1. a numbered step"}
                className={`${field} font-mono text-[13px]`}
              />
            ) : (
              <div className="rounded-lg border border-white/10 bg-[#050a14] p-4">
                <h1 className="mb-2 text-2xl font-semibold text-white">{draft.title || "Untitled"}</h1>
                {draft.summary && <p className="mb-4 text-cyan-100/80">{draft.summary}</p>}
                <ArticleBody body={draft.body} />
              </div>
            )}
          </TabPanel>
        </Panel>
        <Panel className="min-w-0 space-y-3 self-start">
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
            <span className="mt-1 flex items-center gap-1 text-sm text-zinc-400">
              /help/
              <input disabled={!write} value={draft.slug} onChange={up("slug")} placeholder="from the title" className={`${field} min-w-0`} aria-describedby={slugMoved ? "slug-warning" : undefined} />
            </span>
          </label>
          {slugMoved && (
            <p id="slug-warning" className="text-xs text-amber-300">
              This article is published: links to /help/{article?.slug} stop working once the new address is saved.
            </p>
          )}
        </Panel>
      </div>

      {asking === "delete" && article && (
        <Confirm
          title="Delete this article?"
          body={<>“{article.title}” will be removed{published ? " from /help, and links to it stop working" : ""}. The audit log keeps a copy of its text.</>}
          confirmLabel="Delete"
          danger
          typeToConfirm="delete"
          onConfirm={remove}
          onCancel={() => setAsking(null)}
        />
      )}
      {asking === "publish" && article && (
        <Confirm
          title="Publish this article?"
          body={
            <>
              It goes live at /help/{draft.slug.trim() || article.slug} and can be suggested on the contact form.{dirty ? " Your unsaved changes are saved with it." : ""}
            </>
          }
          confirmLabel="Publish"
          onConfirm={() => save("published")}
          onCancel={() => setAsking(null)}
        />
      )}
      {asking === "unpublish" && article && (
        <Confirm
          title="Unpublish this article?"
          body={
            <>
              It disappears from /help and from the contact form&apos;s suggestions, and links to /help/{article.slug} stop working until it is published again.
              {dirty ? " Your unsaved changes are saved with it." : ""}
            </>
          }
          confirmLabel="Unpublish"
          onConfirm={() => save("draft")}
          onCancel={() => setAsking(null)}
        />
      )}
      {asking === "save-slug" && article && (
        <Confirm
          title="Change the address of a published article?"
          body={
            <>
              It moves from /help/{article.slug} to /help/{draft.slug.trim()}. Links people already have to the old address stop working.
            </>
          }
          confirmLabel="Save and move it"
          onConfirm={() => save()}
          onCancel={() => setAsking(null)}
        />
      )}
      {asking === "leave" && (
        <Confirm
          title="Leave without saving?"
          body="Your changes to this article are not saved and will be lost."
          confirmLabel="Leave"
          danger
          onConfirm={() => {
            setSaved(draft);
            setAsking(null);
            router.push("/admin/help");
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}

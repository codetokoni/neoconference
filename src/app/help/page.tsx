// /help — the public help centre: articles, FAQs and troubleshooting guides
// by category, with search. Server-rendered so search engines read it; only
// published articles are ever listed (src/lib/support/help.ts).

import type { Metadata } from "next";
import Link from "next/link";
import { publishedArticles, searchArticles } from "@/lib/support/help";
import { HELP_CATEGORIES, HELP_KIND_LABEL, helpCategoryLabel, isHelpCategory, type HelpArticle } from "@/lib/support/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Help centre — NeoConference",
  description: "Guides, answers and troubleshooting for NeoConference meetings, live translation, recordings, accounts and plans.",
  alternates: { canonical: "/help" },
};

function ArticleLink({ a }: { a: HelpArticle }) {
  return (
    <li>
      <Link href={`/help/${a.slug}`} className="group block rounded-lg px-3 py-2.5 hover:bg-white/5">
        <span className="font-medium text-cyan-50 group-hover:text-white">{a.title}</span>
        {a.kind !== "article" && <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-cyan-200/70">{HELP_KIND_LABEL[a.kind]}</span>}
        {a.summary && <span className="mt-0.5 block text-sm text-cyan-100/60">{a.summary}</span>}
      </Link>
    </li>
  );
}

export default async function HelpPage({ searchParams }: { searchParams?: { q?: string; category?: string } }) {
  const q = (searchParams?.q ?? "").slice(0, 200).trim();
  const category = isHelpCategory(searchParams?.category) ? searchParams!.category : null;
  const all = await publishedArticles();
  const results = q ? await searchArticles(q) : null;
  const shown = category ? all.filter((a) => a.category === category) : all;
  const groups = HELP_CATEGORIES.map((c) => ({ ...c, items: shown.filter((a) => a.category === c.key) })).filter((g) => g.items.length);

  return (
    <section className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Help centre</h1>
      <p className="mt-3 text-cyan-100/70">Answers to common questions about meetings, live translation, recordings, your account and plans.</p>

      <form action="/help" method="get" role="search" className="mt-6 flex gap-2">
        <label htmlFor="help-q" className="sr-only">
          Search help articles
        </label>
        <input
          id="help-q"
          name="q"
          defaultValue={q}
          placeholder="Search, e.g. “recording missing”"
          className="w-full rounded-lg border border-white/12 bg-black/40 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-cyan-400/70"
        />
        <button type="submit" className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-400">
          Search
        </button>
      </form>

      {!q && (
        <nav aria-label="Help categories" className="mt-5 flex flex-wrap gap-2">
          <Link href="/help" aria-current={!category ? "page" : undefined} className={`rounded-full px-3 py-1 text-sm ${!category ? "bg-cyan-400/15 text-cyan-100" : "text-cyan-100/60 hover:bg-white/5"}`}>
            All
          </Link>
          {HELP_CATEGORIES.filter((c) => all.some((a) => a.category === c.key)).map((c) => (
            <Link
              key={c.key}
              href={`/help?category=${c.key}`}
              aria-current={category === c.key ? "page" : undefined}
              className={`rounded-full px-3 py-1 text-sm ${category === c.key ? "bg-cyan-400/15 text-cyan-100" : "text-cyan-100/60 hover:bg-white/5"}`}
            >
              {c.label}
            </Link>
          ))}
        </nav>
      )}

      <div className="mt-8">
        {results ? (
          <>
            <h2 className="text-sm font-medium text-cyan-100/60">
              {results.length} result{results.length === 1 ? "" : "s"} for “{q}”
            </h2>
            {results.length ? (
              <ul className="mt-2 divide-y divide-white/5 rounded-xl border border-white/10 bg-white/[0.03]">
                {results.map((a) => (
                  <ArticleLink key={a.id} a={a} />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-cyan-100/70">Nothing matches. Try other words, or contact support below.</p>
            )}
          </>
        ) : groups.length ? (
          <div className="space-y-8">
            {groups.map((g) => (
              <div key={g.key}>
                <h2 className="mb-2 text-lg font-semibold text-white">{helpCategoryLabel(g.key)}</h2>
                <ul className="divide-y divide-white/5 rounded-xl border border-white/10 bg-white/[0.03]">
                  {g.items.map((a) => (
                    <ArticleLink key={a.id} a={a} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-cyan-100/70">Articles are on their way. In the meantime, our team is happy to help.</p>
        )}
      </div>

      <div className="mt-12 rounded-xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-base font-semibold text-white">Still stuck?</h2>
        <p className="mt-1 text-sm text-cyan-100/70">Chat with us or send a request, and we&apos;ll get back to you.</p>
        <Link href="/support" className="mt-3 inline-flex rounded-lg border border-cyan-400/40 px-3.5 py-2 text-sm font-medium text-cyan-100 hover:bg-cyan-400/10">
          Contact support
        </Link>
      </div>
    </section>
  );
}

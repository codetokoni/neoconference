// /help/[slug] — one published help article, server-rendered with its own
// title and description for search engines, and structured data (an FAQ as
// FAQPage, the rest as Article). A draft answers 404.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ArticleBody from "@/components/help/ArticleBody";
import { publishedArticles } from "@/lib/support/help";
import { HELP_KIND_LABEL, helpCategoryLabel } from "@/lib/support/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function find(slug: string) {
  const all = await publishedArticles();
  const article = all.find((a) => a.slug === slug) ?? null;
  return { article, related: article ? all.filter((a) => a.category === article.category && a.id !== article.id).slice(0, 5) : [] };
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const { article } = await find(params.slug);
  if (!article) return { title: "Help centre — NeoConference" };
  return {
    title: `${article.title} — NeoConference help`,
    description: article.summary || undefined,
    alternates: { canonical: `/help/${article.slug}` },
    openGraph: { title: article.title, description: article.summary || undefined, type: "article" },
  };
}

export default async function HelpArticlePage({ params }: { params: { slug: string } }) {
  const { article: a, related } = await find(params.slug);
  if (!a) notFound();
  const ld =
    a.kind === "faq"
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [{ "@type": "Question", name: a.title, acceptedAnswer: { "@type": "Answer", text: a.body } }],
        }
      : {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: a.title,
          description: a.summary,
          dateModified: new Date(a.updatedAt).toISOString(),
          datePublished: new Date(a.publishedAt ?? a.createdAt).toISOString(),
        };

  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, "\\u003c") }} />
      <nav aria-label="Breadcrumb" className="text-sm text-cyan-100/60">
        <Link href="/help" className="hover:text-cyan-100">
          Help centre
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/help?category=${a.category}`} className="hover:text-cyan-100">
          {helpCategoryLabel(a.category)}
        </Link>
      </nav>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">{a.title}</h1>
      <p className="mt-2 text-sm text-cyan-100/50">
        {HELP_KIND_LABEL[a.kind]} · Updated {new Date(a.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
      </p>
      {a.summary && <p className="mt-4 text-lg text-cyan-100/80">{a.summary}</p>}
      <div className="mt-6">
        <ArticleBody body={a.body} />
      </div>

      {related.length > 0 && (
        <aside className="mt-12">
          <h2 className="text-base font-semibold text-white">More in {helpCategoryLabel(a.category)}</h2>
          <ul className="mt-2 space-y-1">
            {related.map((r) => (
              <li key={r.id}>
                <Link href={`/help/${r.slug}`} className="text-cyan-300 hover:text-cyan-200">
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      )}

      <div className="mt-12 rounded-xl border border-white/10 bg-white/[0.03] p-5">
        <p className="text-sm text-cyan-100/70">Didn&apos;t answer your question?</p>
        <Link href="/support" className="mt-2 inline-flex rounded-lg border border-cyan-400/40 px-3.5 py-2 text-sm font-medium text-cyan-100 hover:bg-cyan-400/10">
          Contact support
        </Link>
      </div>
    </article>
  );
}

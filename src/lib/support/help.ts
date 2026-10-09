// src/lib/support/help.ts
//
// Help-centre articles, FAQs and troubleshooting guides in KV:
//
//   neo:help:articles   hash  id -> HelpArticle JSON
//
// A handful to a few hundred articles: one hash read lists them all, and the
// public pages filter to "published" here, so a draft never reaches /help.

import { kv } from "@/lib/kv";
import { scoreArticle, slugify, type HelpArticle } from "@/lib/support/model";

const ARTICLES = "neo:help:articles";

function parse(raw: unknown): HelpArticle | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as HelpArticle;
  try {
    return JSON.parse(String(raw)) as HelpArticle;
  } catch {
    return null;
  }
}

export async function listArticles(): Promise<HelpArticle[]> {
  const all = ((await kv.hgetall(ARTICLES)) ?? {}) as Record<string, unknown>;
  return Object.values(all)
    .map(parse)
    .filter((a): a is HelpArticle => !!a)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function getArticle(id: string): Promise<HelpArticle | null> {
  if (!id || id.length > 40) return null;
  return parse(await kv.hget(ARTICLES, id));
}

export async function saveArticle(a: HelpArticle): Promise<void> {
  await kv.hset(ARTICLES, { [a.id]: JSON.stringify(a) });
}

export async function deleteArticle(id: string): Promise<void> {
  await kv.hdel(ARTICLES, id);
}

/** Only what the public may see. */
export async function publishedArticles(): Promise<HelpArticle[]> {
  return (await listArticles()).filter((a) => a.status === "published");
}

export async function publishedBySlug(slug: string): Promise<HelpArticle | null> {
  return (await publishedArticles()).find((a) => a.slug === slug) ?? null;
}

/** A slug no other article uses: "reset-password", then "reset-password-2". */
export function uniqueSlug(wanted: string, all: HelpArticle[], selfId?: string): string {
  const base = slugify(wanted);
  const taken = new Set(all.filter((a) => a.id !== selfId).map((a) => a.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Published articles that best answer `text`, best first. */
export async function suggestArticles(text: string, ticketCategory?: string, limit = 3) {
  return (await publishedArticles())
    .map((a) => ({ a, score: scoreArticle(a, text, ticketCategory) }))
    .filter((x) => x.score >= 3)
    .sort((x, y) => y.score - x.score || x.a.title.localeCompare(y.a.title))
    .slice(0, limit)
    .map(({ a }) => ({ slug: a.slug, title: a.title, summary: a.summary, kind: a.kind }));
}

/** Public search for /help: every published article with any hit, best first. */
export async function searchArticles(text: string) {
  return (await publishedArticles())
    .map((a) => ({ a, score: scoreArticle(a, text) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}

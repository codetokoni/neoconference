// src/lib/support/articleInput.ts — validating an article from the editor,
// and the view of one the audit trail keeps.

import { HELP_KINDS, isHelpCategory, slugify, type HelpArticle, type HelpKind } from "@/lib/support/model";
import { cleanTags } from "@/lib/support/admin";

type Editable = Pick<HelpArticle, "title" | "summary" | "body" | "category" | "kind" | "tags" | "status" | "slug">;

/**
 * The editable fields from `input`, over `current` for an edit (fields left
 * out keep their value) or from scratch for a new article.
 */
export function articleFields(input: unknown, current: HelpArticle | null): { ok: true; value: Editable } | { ok: false; error: string; message: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "invalid_body", message: "Send the article as JSON." };
  const b = input as Record<string, unknown>;
  const s = (k: string, max: number, fallback: string) => (typeof b[k] === "string" ? (b[k] as string).trim().slice(0, max) : fallback);
  const value: Editable = {
    title: s("title", 160, current?.title ?? ""),
    summary: s("summary", 300, current?.summary ?? ""),
    body: typeof b.body === "string" ? b.body.replace(/\r\n/g, "\n").slice(0, 50000) : current?.body ?? "",
    category: (isHelpCategory(b.category) ? b.category : current?.category) as HelpArticle["category"],
    kind: ((HELP_KINDS as readonly string[]).includes(String(b.kind)) ? b.kind : current?.kind ?? "article") as HelpKind,
    tags: b.tags !== undefined ? cleanTags(b.tags) ?? [] : current?.tags ?? [],
    status: b.status === "published" || b.status === "draft" ? b.status : current?.status ?? "draft",
    slug: typeof b.slug === "string" && b.slug.trim() ? slugify(b.slug) : current?.slug ?? "",
  };
  if (value.title.length < 3) return { ok: false, error: "invalid_title", message: "Give the article a title." };
  if (!value.body.trim()) return { ok: false, error: "invalid_body", message: "Write the article." };
  if (!value.category) return { ok: false, error: "invalid_category", message: "Choose a category." };
  return { ok: true, value };
}

/** What the audit trail records of an article: every field, the body cut to 2,000 characters. */
export function auditView(a: HelpArticle) {
  return {
    title: a.title,
    slug: a.slug,
    status: a.status,
    category: a.category,
    kind: a.kind,
    tags: a.tags,
    summary: a.summary,
    body: a.body.length > 2000 ? `${a.body.slice(0, 2000)}… (${a.body.length} characters)` : a.body,
  };
}

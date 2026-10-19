// src/app/sitemap.ts — served as /sitemap.xml.
//
// The public pages and the published help articles, at the current brand's
// address (src/lib/brand.ts), so search engines learn the new domain.

import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";
import { publishedArticles } from "@/lib/support/help";

export const dynamic = "force-dynamic";

const PAGES = ["/", "/pricing", "/explore", "/help", "/support", "/docs"];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages: MetadataRoute.Sitemap = PAGES.map((p) => ({ url: BRAND.origin + p }));
  try {
    const articles = await publishedArticles();
    for (const a of articles) pages.push({ url: `${BRAND.origin}/help/${encodeURIComponent(a.slug)}` });
  } catch {
    // The help store being down leaves the main pages, which matter most.
  }
  return pages;
}

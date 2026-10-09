// GET /api/help/suggest?q=<text>&category=<ticket category>
// Published help articles that may answer what someone is about to ask, for
// the contact form. Public, read-only, and never returns a draft.

import { NextResponse } from "next/server";
import { suggestArticles } from "@/lib/support/help";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 300);
  const category = url.searchParams.get("category")?.slice(0, 40) || undefined;
  const items = q.trim().length >= 3 ? await suggestArticles(q, category, 3) : [];
  return NextResponse.json({ items }, { headers: { "cache-control": "no-store" } });
}

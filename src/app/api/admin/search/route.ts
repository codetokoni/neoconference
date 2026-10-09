// GET /api/admin/search?q=… — the admin top bar's search (any administrator).
//
// Searches only the categories the caller's role can open (users, groups,
// meetings, payments, tickets, files, audit entries); the others are not
// searched and not mentioned. Each category answers on its own. See
// src/lib/admin/search.ts.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { MIN_QUERY, adminSearch, searchableCategories } from "@/lib/admin/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, null);
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const q = (p.get("q") || "").trim();
  const only = (p.get("only") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const categories = await adminSearch(g.ctx.permissions, q, { only, limit: Number(p.get("limit")) || undefined });
  return NextResponse.json({ ok: true, q, minLength: MIN_QUERY, searchable: searchableCategories(g.ctx.permissions), categories });
}

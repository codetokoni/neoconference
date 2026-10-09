// GET /api/admin/overview — the admin dashboard's figures (overview:read).
//
// Query: range = today | 7d | 30d | 90d | this_month | last_month | custom
// (from, to: YYYY-MM-DD for custom), compare = previous | last_year,
// tz (IANA; days are calendar days there), refresh=1 to skip the 60 s cache,
// only=<source>[,<source>] to load some cards.
//
// Each card's source also needs its own permission (src/lib/admin/overview/
// sources.ts): a source the role lacks is absent from the answer, not zero.
// A source that fails is an error on its own card; the rest still answer.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { buildOverview } from "@/lib/admin/overview/aggregate";
import { readQuery, resolvePeriods } from "@/lib/admin/overview/period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const g = await requireAdmin(req, "overview:read");
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const query = readQuery(p);
  const only = (p.get("only") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const overview = await buildOverview(g.ctx.permissions, resolvePeriods(query), { fresh: p.get("refresh") === "1", only });
  return NextResponse.json({ ok: true, query, ...overview });
}

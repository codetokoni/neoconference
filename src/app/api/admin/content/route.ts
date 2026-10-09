// /api/admin/content — content:read
//
// GET ?q&owner&type&status&visibility&state&minSize&maxSize&from&to&sort&dir&limit&offset
//     Search the file index. Metadata only: opening a file's contents is
//     ./files/[id]/open. Also returns storage totals per type and where the
//     backfill stands.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { filterRows, loadRows, parseFileQuery, sortRows, usageTotals } from "@/lib/content/admin";
import { backfillState } from "@/lib/content/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  const q = parseFileQuery(new URL(req.url));
  const rows = await loadRows();
  const matched = sortRows(filterRows(rows, q), q);
  const usage = usageTotals(rows);
  return NextResponse.json({
    items: matched.slice(q.offset, (q.offset ?? 0) + (q.limit ?? 50)),
    total: matched.length,
    matchedBytes: matched.reduce((s, r) => s + r.size, 0),
    totals: { ...usage.total, byType: usage.byType },
    backfill: await backfillState(),
  });
}

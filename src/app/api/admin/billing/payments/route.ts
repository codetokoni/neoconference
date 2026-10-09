// GET /api/admin/billing/payments — every payment (billing:read).
//
// Query: from, to (YYYY-MM-DD, UTC; or epoch ms), status (paid |
// partially_refunded | refunded | failed | refunds), provider (espees |
// stripe | manual), plan (tier, catalog plan id, or "ticket"), user (user
// id or part of an email), q (reference, invoice number, email, name),
// offset, limit.
//
// Totals cover every match, per currency.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { indexSize, queryLedger } from "@/lib/finance/ledger";
import { ledgerQuery } from "@/lib/finance/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "billing:read");
  if (!g.ok) return g.response;
  const q = ledgerQuery(new URL(req.url).searchParams);
  const page = await queryLedger(q);
  return NextResponse.json({ ok: true, ...page, offset: q.offset, limit: q.limit, indexed: await indexSize() });
}

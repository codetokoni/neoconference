// GET /api/admin/subscriptions (plans:read) — lists for the Subscriptions
// screen:
//
//   ?view=upcoming&days=30   periods (and trials) ending in the next N days,
//                            soonest first: renewals due, expiries, scheduled
//                            changes
//   ?view=ended&days=30      ended in the last N days
//   ?view=all[&status=…][&plan=…]  every record
//
// From the zsets in src/lib/billing/subscriptions.ts; accounts from before
// the catalog appear once the backfill has run.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { DAY_MS, SUB_STATUSES, hasAccess, type SubStatus } from "@/lib/billing/model";
import { listByPeriodEnd, listEnded, listSubscriptions } from "@/lib/billing/subscriptions";
import { subRow } from "@/lib/billing/adminViews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "plans:read");
  if (!g.ok) return g.response;
  const url = new URL(req.url);
  const view = url.searchParams.get("view") || "upcoming";
  const days = Math.max(1, Math.min(Number(url.searchParams.get("days")) || 30, 3650));
  const now = Date.now();
  if (view === "upcoming") {
    const rows = (await listByPeriodEnd(now, now + days * DAY_MS)).map(subRow);
    return NextResponse.json({ ok: true, view, days, rows });
  }
  if (view === "ended") {
    const rows = (await listEnded(now - days * DAY_MS, now)).map(subRow);
    return NextResponse.json({ ok: true, view, days, rows });
  }
  const status = url.searchParams.get("status") as SubStatus | null;
  const plan = url.searchParams.get("plan");
  const all = await listSubscriptions();
  const counts: Record<string, number> = {};
  for (const s of SUB_STATUSES) counts[s] = 0;
  for (const s of all) counts[s.status]++;
  const rows = all
    .filter((s) => !status || s.status === status)
    .filter((s) => !plan || s.planId === plan)
    .sort((a, b) => Number(hasAccess(b, now)) - Number(hasAccess(a, now)) || (a.periodEnd ?? Infinity) - (b.periodEnd ?? Infinity))
    .slice(0, 1000)
    .map(subRow);
  return NextResponse.json({ ok: true, view: "all", rows, counts, total: all.length });
}

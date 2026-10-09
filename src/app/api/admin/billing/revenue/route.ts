// GET /api/admin/billing/revenue — revenue figures (billing:read).
//
// Query: from, to (YYYY-MM-DD UTC or epoch ms; default the last 30 days),
// bucket (day | week | month; default by the range's length).
// Compared with the period of the same length just before. Definitions in
// src/lib/finance/revenue.ts. Every amount is per currency.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { entriesBetween, lookupUser } from "@/lib/finance/ledger";
import { listCheckouts } from "@/lib/finance/checkouts";
import { getHistory, listSubscriptions } from "@/lib/billing/subscriptions";
import { timeParam } from "@/lib/finance/query";
import {
  DAY,
  activeUserIds,
  autoBucket,
  comparison,
  endedSubscriptions,
  outstanding,
  periodFigures,
  recurring,
  recurringFromSubscriptions,
  series,
  type Bucket,
  type SubLike,
} from "@/lib/finance/revenue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Accounts checked against Clerk per request; past this MRR is from payments alone. */
const CLERK_CHECK_CAP = 300;

export async function GET(req: Request) {
  const g = await requireAdmin(req, "billing:read");
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const now = Date.now();
  const to = Math.min(timeParam(p.get("to"), true) ?? now, now);
  const from = timeParam(p.get("from"), false) ?? to - 30 * DAY + 1;
  if (!(from < to)) return NextResponse.json({ error: "bad_range", message: "The start must be before the end." }, { status: 400 });
  const len = to - from + 1;
  const prevFrom = from - len;
  const prevTo = from - 1;
  const b = p.get("bucket");
  const bucket: Bucket = b === "day" || b === "week" || b === "month" ? b : autoBucket(from, to);

  // Lapses look back one paid period (up to a year) before the range.
  const entries = await entriesBetween(Math.min(prevFrom, from - 400 * DAY), to);
  const current = periodFigures(entries, from, to, now);
  const previous = periodFigures(entries, prevFrom, prevTo, now);

  const asOf = to;
  const active = activeUserIds(entries, asOf);
  let clerkPlans: Map<string, string | null> | undefined;
  if (active.length <= CLERK_CHECK_CAP) {
    clerkPlans = new Map();
    for (let i = 0; i < active.length; i += 10) {
      const chunk = active.slice(i, i + 10);
      const who = await Promise.all(chunk.map((id) => lookupUser(id)));
      chunk.forEach((id, j) => {
        const w = who[j];
        const expired = w.planExpiresAt != null && w.planExpiresAt < now;
        clerkPlans!.set(id, w.exists && !expired ? w.plan : null);
      });
    }
  }

  const fromPayments = recurring(entries, asOf, clerkPlans);

  // Subscription records (Plans & subscriptions) are the better source for
  // what is running, renewed and ended, where they exist. Accounts from
  // before them have none until the Clerk backfill there is run, so the
  // payment-based MRR stays alongside as a check.
  const subs = (await listSubscriptions()) as unknown as SubLike[];
  const fromSubs = subs.length > 0;
  if (fromSubs) {
    const history = (await Promise.all(subs.map((s) => getHistory(s.userId, 500)))).flat();
    const renewals = (a: number, b: number) => history.filter((h) => h.action === "purchase.renew" && h.ts >= a && h.ts <= b).length;
    current.renewals = renewals(from, to);
    previous.renewals = renewals(prevFrom, prevTo);
    current.cancellations = { ...endedSubscriptions(subs, from, to, now) };
    previous.cancellations = { ...endedSubscriptions(subs, prevFrom, prevTo, now) };
    current.basis = previous.basis = "subscriptions";
  }
  // Records describe now; a range ending in the past uses the payments.
  const recurringNow = fromSubs && to >= now - DAY ? recurringFromSubscriptions(subs, now) : fromPayments;

  return NextResponse.json({
    ok: true,
    range: { from, to },
    previousRange: { from: prevFrom, to: prevTo },
    bucket,
    current,
    previous,
    change: comparison(current, previous),
    series: series(entries, from, to, bucket),
    recurring: recurringNow,
    recurringFromPayments: fromPayments,
    outstanding: outstanding(await listCheckouts(from, to), entries, from, to, now),
    subscriptions: { records: subs.length, used: fromSubs },
  });
}

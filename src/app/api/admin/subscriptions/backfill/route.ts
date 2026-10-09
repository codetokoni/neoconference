// POST /api/admin/subscriptions/backfill (subscriptions:write) — one-off:
// a subscription record for every account with a paid plan in Clerk that
// has none yet, so renewals, expiries and history cover accounts from
// before the plan catalog. Idempotent; skips the owner and expired plans.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { backfillFromClerk } from "@/lib/billing/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const g = await requireAdmin(req, "subscriptions:write");
  if (!g.ok) return g.response;
  const result = await backfillFromClerk(actorOf(g.ctx));
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "subscription.backfill",
    targetType: "subscription",
    targetId: "*",
    targetLabel: "backfill from Clerk",
    after: result,
  });
  return NextResponse.json({ ok: true, ...result });
}

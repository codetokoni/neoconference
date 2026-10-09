// POST /api/admin/billing/backfill — list every payment made before the
// payments index existed (billing:settings, fresh code). Reads every
// billing:payment:* record and billing:payments:* list, and — when
// STRIPE_SECRET_KEY is set — the completed ticket Checkout Sessions in
// Stripe. Only adds; safe to run again. Audited.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { backfillIndex, type StripeSessionLike } from "@/lib/finance/ledger";
import { isStripeConfigured, listCompletedCheckoutSessions } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const g = await requireAdmin(req, "billing:settings");
  if (!g.ok) return g.response;
  const result = await backfillIndex(
    isStripeConfigured() ? async () => (await listCompletedCheckoutSessions()) as StripeSessionLike[] : undefined,
  );
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "billing.backfill",
    targetType: "billing_index",
    targetId: "billing:index",
    targetLabel: "Payments index",
    after: result,
    outcome: result.stripe === "failed" ? "failed" : "ok",
  });
  return NextResponse.json({ ok: true, result });
}

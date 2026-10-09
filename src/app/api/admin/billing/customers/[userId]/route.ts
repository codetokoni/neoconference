// GET /api/admin/billing/customers/[userId] — one account's billing
// history (billing:read): payments and refunds, checkouts started, the
// reminders sent to them, and the plan their account holds now.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { lookupUser, userEntries } from "@/lib/finance/ledger";
import { checkoutState, listCheckouts } from "@/lib/finance/checkouts";
import { readReminderLog } from "@/lib/finance/reminders";
import { isOwnerAccount } from "@/lib/finance/planChange";
import { addTo, type ByCurrency } from "@/lib/finance/money";
import { entryIdParam } from "@/lib/finance/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { userId: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "billing:read");
  if (!g.ok) return g.response;
  const userId = entryIdParam(params.userId);
  const who = await lookupUser(userId);
  const payments = (await userEntries(userId)).map((e) => ({ ...e, email: e.email ?? who.email, name: e.name ?? who.name }));
  const now = Date.now();
  const checkouts = (await listCheckouts(now - 400 * 24 * 60 * 60 * 1000, now))
    .filter((c) => c.userId === userId)
    .map((c) => ({ ...c, state: checkoutState(c, now) }))
    .reverse();
  const paid: ByCurrency = {};
  const refunded: ByCurrency = {};
  for (const e of payments) {
    if (e.status !== "failed") addTo(paid, e.currency, e.amount);
    if (e.refundedAmount) addTo(refunded, e.currency, e.refundedAmount);
  }
  const reminders = (await readReminderLog(500)).filter((r) => r.userId === userId);
  return NextResponse.json({
    ok: true,
    user: { userId, email: who.email, name: who.name, exists: who.exists, plan: who.plan, planExpiresAt: who.planExpiresAt, isOwner: await isOwnerAccount(userId) },
    totals: { paid, refunded },
    payments,
    checkouts,
    reminders,
  });
}

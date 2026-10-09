// GET /api/admin/billing/payments/[id] — one payment, its invoice if issued,
// how it can be refunded, and the buyer's other payments (billing:read).
// [id] is a ledger id: "pay:<eSPees ref>" or "tkt:<Stripe session id>".

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import { lookupUser, readEntry, userEntries, withPeople } from "@/lib/finance/ledger";
import { readInvoice } from "@/lib/finance/invoice";
import { refundMethodFor } from "@/lib/finance/refunds";
import { isOwnerAccount } from "@/lib/finance/planChange";
import { entryIdParam } from "@/lib/finance/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "billing:read");
  if (!g.ok) return g.response;
  const found = await readEntry(entryIdParam(params.id));
  if (!found) return fail("not_found", "No such payment.", 404);
  const [entry] = await withPeople([found]);
  const others = entry.userId ? (await userEntries(entry.userId)).filter((e) => e.id !== entry.id) : [];
  const account = entry.userId ? await lookupUser(entry.userId) : null;
  return NextResponse.json({
    ok: true,
    entry,
    invoice: await readInvoice(entry.id),
    refund: {
      method: refundMethodFor(entry),
      remaining: Math.max(0, entry.amount - entry.refundedAmount),
      currency: entry.currency,
      canEndPlan: entry.kind === "plan" && !!entry.userId && !(await isOwnerAccount(entry.userId)),
    },
    account: account && { plan: account.plan, planExpiresAt: account.planExpiresAt, exists: account.exists },
    others,
  });
}

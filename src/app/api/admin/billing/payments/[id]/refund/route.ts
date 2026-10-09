// POST /api/admin/billing/payments/[id]/refund — refund a payment
// (billing:refund: sensitive, so a fresh authenticator code too).
//
// Body: { amount?, currency, reason, downgrade?, outsideRef? }
//   currency   must match the payment's: the screen showed it, the admin confirmed it
//   outsideRef required for eSPees and manual payments, which are refunded
//              outside NeoConference (eSPees has no refund API) and recorded here
//   downgrade  also end the buyer's plan now (never the owner's)
//
// See src/lib/finance/refunds.ts.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { fail, readJson, str } from "@/lib/admin/http";
import { refundPayment } from "@/lib/finance/refunds";
import { entryIdParam } from "@/lib/finance/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "billing:refund");
  if (!g.ok) return g.response;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return fail("invalid_body", "Send JSON.");
  const amount = body.amount === undefined || body.amount === null || body.amount === "" ? undefined : Number(body.amount);
  if (amount !== undefined && !Number.isFinite(amount)) return fail("bad_amount", "The amount must be a number.");
  const r = await refundPayment(actorOf(g.ctx), req, {
    id: entryIdParam(params.id),
    amount,
    currency: str(body.currency, 8),
    reason: str(body.reason, 300),
    downgrade: body.downgrade === true,
    outsideRef: str(body.outsideRef, 120),
  });
  if (!r.ok) return fail(r.error, r.message, r.status);
  return NextResponse.json({ ok: true, entry: r.entry, refund: r.refund, downgraded: r.downgraded });
}

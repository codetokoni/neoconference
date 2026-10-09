// GET /api/admin/billing/payments/[id]/invoice — the invoice for a payment
// (billing:read). Issued (numbered and frozen) the first time it is opened;
// that issue is recorded in the admin audit log. ?format=pdf downloads it.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import { recordAdminAction } from "@/lib/admin/audit";
import { readEntry, withPeople } from "@/lib/finance/ledger";
import { invoicePdf, issueInvoice } from "@/lib/finance/invoice";
import { entryIdParam } from "@/lib/finance/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "billing:read");
  if (!g.ok) return g.response;
  const found = await readEntry(entryIdParam(params.id));
  if (!found) return fail("not_found", "No such payment.", 404);
  if (found.status === "failed") return fail("failed_payment", "A failed payment has no invoice: no money was taken.", 409);
  const [entry] = await withPeople([found]);
  const { invoice, issued } = await issueInvoice(entry);
  if (issued) {
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "billing.invoice.issue",
      targetType: "payment",
      targetId: entry.id,
      targetLabel: `${invoice.number} · ${entry.ref}`,
      after: { number: invoice.number, total: invoice.total, currency: invoice.currency, tax: invoice.tax },
    });
  }
  if (new URL(req.url).searchParams.get("format") === "pdf") {
    const bytes = await invoicePdf(invoice, entry.refunds);
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${invoice.number}.pdf"`,
        "cache-control": "no-store",
      },
    });
  }
  return NextResponse.json({ ok: true, invoice, refunds: entry.refunds, status: entry.status, issued });
}

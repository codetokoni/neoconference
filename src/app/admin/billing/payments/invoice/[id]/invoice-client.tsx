"use client";

// One invoice / receipt, as issued (numbered and frozen on first view), with
// the refunds made since. Print it, or download the PDF.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtMoney, useAdmin } from "../../../../AdminApi";
import { Loading, Notice, btn } from "../../../../ui";
import { day, type RefundRow } from "../../../shared";

type Invoice = {
  number: string;
  issuedAt: number;
  ref: string;
  provider: string;
  currency: string;
  seller: { companyName: string; address: string; taxId: string; email: string; footer: string };
  buyer: { name: string | null; email: string | null; userId: string | null; country: string | null };
  lines: { description: string; period: string | null; amount: number }[];
  tax: { label: string; rate: number; inclusive: boolean; amount: number } | null;
  subtotal: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  paidAt: number;
  verified: boolean;
};

export default function InvoiceClient({ id }: { id: string }) {
  const { adminFetch, adminDownload } = useAdmin();
  const [data, setData] = useState<{ invoice: Invoice; refunds: RefundRow[]; issued: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const r = await adminFetch<{ invoice: Invoice; refunds: RefundRow[]; issued: boolean }>(`/api/admin/billing/payments/${encodeURIComponent(id)}/invoice`);
    if (r.ok) setData(r.data);
    else setError(r.data.message ?? "Could not open the invoice.");
  }, [adminFetch, id]);
  useEffect(() => {
    load();
  }, [load]);

  const downloadPdf = async () => {
    setPdfBusy(true);
    setPdfError(null);
    const r = await adminDownload(`/api/admin/billing/payments/${encodeURIComponent(id)}/invoice?format=pdf`);
    setPdfBusy(false);
    if (!r.ok && r.data.error !== "cancelled") setPdfError(r.data.message ?? "The PDF could not be downloaded.");
  };

  if (error)
    return (
      <Notice kind="err" onRetry={load}>
        {error}
      </Notice>
    );
  if (!data) return <Loading />;
  const { invoice: inv, refunds } = data;
  const m = (v: number) => fmtMoney(v, inv.currency);
  const refunded = refunds.reduce((s, r) => s + r.amount, 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href="/admin/billing/payments" className="text-sm text-cyan-300 hover:underline">
          ← Payments
        </Link>
        <div className="flex gap-2">
          <button type="button" className={btn.ghost} onClick={() => window.print()}>
            Print
          </button>
          <button type="button" className={btn.primary} disabled={pdfBusy} onClick={downloadPdf}>
            {pdfBusy ? "Preparing PDF…" : "Download PDF"}
          </button>
        </div>
      </div>
      {pdfError && (
        <div className="print:hidden">
          <Notice kind="err" onClose={() => setPdfError(null)}>
            {pdfError}
          </Notice>
        </div>
      )}
      {data.issued && (
        <p className="mb-3 text-xs text-zinc-400 print:hidden">Issued just now as {inv.number}. It will not change if the invoice details in Billing settings change later.</p>
      )}
      <article className="mx-auto max-w-2xl rounded-xl bg-white p-8 text-[13px] text-zinc-900 shadow-xl print:shadow-none">
        <header className="flex flex-wrap justify-between gap-4">
          <div>
            <p className="text-xl font-bold">{inv.seller.companyName}</p>
            <p className="whitespace-pre-line text-zinc-600">{inv.seller.address}</p>
            {inv.seller.taxId && <p className="text-zinc-600">Tax ID: {inv.seller.taxId}</p>}
            {inv.seller.email && <p className="text-zinc-600">{inv.seller.email}</p>}
          </div>
          <div className="text-right">
            <h1 className="text-lg font-bold">{inv.balanceDue > 0 ? "INVOICE" : "INVOICE / RECEIPT"}</h1>
            <p>
              No. <b>{inv.number}</b>
            </p>
            <p className="text-zinc-600">Issued {day(inv.issuedAt)}</p>
            <p className="text-zinc-600">Paid {day(inv.paidAt)}</p>
          </div>
        </header>
        <section className="mt-6">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-600">Bill to</p>
          <p>{inv.buyer.name ?? inv.buyer.email ?? inv.buyer.userId ?? "Guest buyer"}</p>
          {inv.buyer.name && inv.buyer.email && <p>{inv.buyer.email}</p>}
          {inv.buyer.country && <p>{inv.buyer.country}</p>}
        </section>
        <table className="mt-6 w-full">
          <thead>
            <tr className="border-b border-zinc-300 text-left text-[11px] uppercase tracking-wider text-zinc-600">
              <th className="py-1.5 font-semibold">Description</th>
              <th className="py-1.5 text-right font-semibold">Amount ({inv.currency})</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i} className="border-b border-zinc-100">
                <td className="py-2">
                  {l.description}
                  {l.period && <div className="text-xs text-zinc-600">Period {l.period}</div>}
                </td>
                <td className="py-2 text-right tabular-nums">{m(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="ml-auto mt-3 grid max-w-xs grid-cols-2 gap-y-1 tabular-nums">
          <dt>Subtotal</dt>
          <dd className="text-right">{m(inv.subtotal)}</dd>
          {inv.tax && (
            <>
              <dt>
                {inv.tax.label} {inv.tax.rate}%{inv.tax.inclusive ? " (included)" : ""}
              </dt>
              <dd className="text-right">{m(inv.tax.amount)}</dd>
            </>
          )}
          <dt className="font-bold">Total</dt>
          <dd className="text-right font-bold">{m(inv.total)}</dd>
          <dt>Amount paid</dt>
          <dd className="text-right">{m(inv.amountPaid)}</dd>
          {inv.balanceDue > 0 && (
            <>
              <dt className="font-bold">Balance due</dt>
              <dd className="text-right font-bold">{m(inv.balanceDue)}</dd>
            </>
          )}
          {refunds.map((r) => (
            <div key={r.id} className="col-span-2 grid grid-cols-2 text-red-700">
              <dt>Refunded {day(r.at)}</dt>
              <dd className="text-right">−{fmtMoney(r.amount, r.currency)}</dd>
            </div>
          ))}
          {refunded > 0 && (
            <>
              <dt className="font-bold">Net paid</dt>
              <dd className="text-right font-bold">{m(inv.amountPaid - refunded)}</dd>
            </>
          )}
        </dl>
        <p className="mt-6 text-xs text-zinc-600">
          Payment reference {inv.ref} · paid with {inv.provider === "stripe" ? "card (Stripe)" : inv.provider === "manual" ? "a direct arrangement" : "Espees"} · all amounts in {inv.currency}
          {inv.currency === "ESP" ? " (Espees)" : ""}.
        </p>
        {inv.seller.footer && <p className="mt-4 whitespace-pre-line border-t border-zinc-200 pt-3 text-xs text-zinc-600">{inv.seller.footer}</p>}
      </article>
      {inv.balanceDue > 0 && (
        <p className="mx-auto mt-3 max-w-2xl text-xs text-amber-200/90 print:hidden">
          The tax rule for this buyer adds tax on top of the price, but checkout charged the price alone — so this invoice shows a balance due. Use an inclusive rule if prices already include tax.
        </p>
      )}
    </div>
  );
}

// src/lib/finance/invoice.ts
//
// Invoices and receipts for payments, from the admin billing area.
//
// An invoice is issued once — the first time anyone opens it — and then
// frozen:
//
//   billing:invoice:<ledger id>   Invoice (number, seller and buyer details,
//                                 lines, tax), never rewritten
//
// The number comes from the same counter as paymentsStore's
// assignInvoiceNumber (billing:invoice:seq, "NEO-000001"), so plan and
// ticket invoices share one gap-free series. Changing the seller details or
// tax rules in Billing settings changes invoices issued after that, not
// ones already issued. Refunds are shown on the document as they stand when
// it is opened.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { kv } from "@/lib/kv";
import { assignInvoiceNumber } from "@/lib/paymentsStore";
import { fmtMoney, round } from "@/lib/finance/money";
import { readTicket, saveTicket, type LedgerEntry, type RefundEntry } from "@/lib/finance/ledger";
import { getBillingSettings, taxRuleFor, type InvoiceDetails } from "@/lib/finance/settings";

const KEY = (id: string) => `billing:invoice:${id}`;
const SEQ = "billing:invoice:seq";

export interface Invoice {
  number: string;
  issuedAt: number;
  entryId: string;
  ref: string;
  provider: string;
  currency: string;
  seller: InvoiceDetails;
  buyer: { name: string | null; email: string | null; userId: string | null; country: string | null };
  lines: { description: string; period: string | null; amount: number }[];
  tax: { label: string; rate: number; inclusive: boolean; amount: number } | null;
  subtotal: number;
  total: number;
  amountPaid: number;
  /** Non-zero only with an exclusive tax rule: checkout charged the price without it. */
  balanceDue: number;
  paidAt: number;
  verified: boolean;
}

export async function readInvoice(entryId: string): Promise<Invoice | null> {
  return ((await kv.get<Invoice>(KEY(entryId))) ?? null) as Invoice | null;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Issue the invoice for a payment, or return the one already issued. */
export async function issueInvoice(e: LedgerEntry): Promise<{ invoice: Invoice; issued: boolean }> {
  const existing = await readInvoice(e.id);
  if (existing) return { invoice: existing, issued: false };
  if (e.status === "failed") throw new Error("failed_payment");

  let number: string;
  if (e.kind === "plan") {
    number = (await assignInvoiceNumber(e.ref)).number;
  } else {
    const t = await readTicket(e.ref);
    if (!t) throw new Error("payment_not_found");
    number = t.invoiceNumber ?? `NEO-${String(Number(await kv.incr(SEQ))).padStart(6, "0")}`;
    if (!t.invoiceNumber) await saveTicket({ ...t, invoiceNumber: number });
  }

  const settings = await getBillingSettings();
  const rule = taxRuleFor(settings.tax.rules, e.country);
  const amount = e.amount;
  let subtotal = amount;
  let total = amount;
  let tax: Invoice["tax"] = null;
  if (rule && rule.rate > 0) {
    if (rule.inclusive) {
      const t = round(amount - amount / (1 + rule.rate / 100), e.currency);
      subtotal = round(amount - t, e.currency);
      tax = { label: rule.label, rate: rule.rate, inclusive: true, amount: t };
    } else {
      const t = round((amount * rule.rate) / 100, e.currency);
      total = round(amount + t, e.currency);
      tax = { label: rule.label, rate: rule.rate, inclusive: false, amount: t };
    }
  }
  const invoice: Invoice = {
    number,
    issuedAt: Date.now(),
    entryId: e.id,
    ref: e.ref,
    provider: e.provider,
    currency: e.currency,
    seller: settings.invoice,
    buyer: { name: e.name, email: e.email, userId: e.userId, country: e.country ?? null },
    lines: [
      {
        description: e.description,
        period: e.periodStart && e.periodEnd ? `${day(e.periodStart)} to ${day(e.periodEnd)}` : null,
        amount: subtotal,
      },
    ],
    tax,
    subtotal,
    total,
    amountPaid: amount,
    balanceDue: round(total - amount, e.currency),
    paidAt: e.at,
    verified: e.verified,
  };
  // NX: two first views at once must not leave two different invoices.
  const won = (await kv.set(KEY(e.id), invoice, { nx: true })) !== null;
  return won ? { invoice, issued: true } : { invoice: (await readInvoice(e.id))!, issued: false };
}

/* --------------------------------- PDF --------------------------------- */

/** Helvetica only draws Latin-1; anything else becomes "?" rather than throwing. */
function safe(s: string): string {
  return s.replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

export async function invoicePdf(inv: Invoice, refunds: RefundEntry[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${inv.number}`);
  doc.setProducer("NeoConference");
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.42, 0.42, 0.46);
  let y = 790;
  const text = (p: PDFPage, s: string, x: number, size = 10, f: PDFFont = font, color = ink) => p.drawText(safe(s), { x, y, size, font: f, color });
  const right = (p: PDFPage, s: string, xr: number, size = 10, f: PDFFont = font) => p.drawText(safe(s), { x: xr - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color: ink });
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  text(page, inv.seller.companyName || "NeoConference", 50, 18, bold);
  right(page, inv.balanceDue > 0 ? "INVOICE" : "INVOICE / RECEIPT", 545, 14, bold);
  y -= 18;
  for (const l of lines(inv.seller.address)) {
    text(page, l, 50, 9, font, grey);
    y -= 12;
  }
  if (inv.seller.taxId) {
    text(page, `Tax ID: ${inv.seller.taxId}`, 50, 9, font, grey);
    y -= 12;
  }
  if (inv.seller.email) {
    text(page, inv.seller.email, 50, 9, font, grey);
    y -= 12;
  }

  y = 740;
  const meta: [string, string][] = [
    ["Invoice number", inv.number],
    ["Issued", day(inv.issuedAt)],
    ["Paid", day(inv.paidAt)],
    ["Payment reference", inv.ref],
    ["Paid with", inv.provider === "stripe" ? "Card (Stripe)" : inv.provider === "manual" ? "Arranged directly" : "Espees"],
  ];
  for (const [k, v] of meta) {
    right(page, `${k}: ${v}`, 545, 9);
    y -= 13;
  }

  y = Math.min(y, 660) - 10;
  text(page, "Bill to", 50, 9, bold, grey);
  y -= 14;
  for (const l of [inv.buyer.name, inv.buyer.email, inv.buyer.country].filter(Boolean) as string[]) {
    text(page, l, 50, 10);
    y -= 13;
  }
  if (!inv.buyer.name && !inv.buyer.email) {
    text(page, inv.buyer.userId ?? "Guest buyer", 50, 10);
    y -= 13;
  }

  y -= 20;
  page.drawLine({ start: { x: 50, y: y + 14 }, end: { x: 545, y: y + 14 }, thickness: 0.6, color: grey });
  text(page, "Description", 50, 9, bold, grey);
  right(page, `Amount (${inv.currency})`, 545, 9, bold);
  y -= 18;
  for (const line of inv.lines) {
    text(page, line.description, 50, 10);
    right(page, fmtMoney(line.amount, inv.currency), 545, 10);
    y -= 13;
    if (line.period) {
      text(page, `Period ${line.period}`, 50, 9, font, grey);
      y -= 13;
    }
  }
  y -= 8;
  page.drawLine({ start: { x: 300, y: y + 12 }, end: { x: 545, y: y + 12 }, thickness: 0.6, color: grey });
  const total = (label: string, v: string, b = false) => {
    text(page, label, 300, 10, b ? bold : font);
    right(page, v, 545, 10, b ? bold : font);
    y -= 15;
  };
  total("Subtotal", fmtMoney(inv.subtotal, inv.currency));
  if (inv.tax) total(`${inv.tax.label} ${inv.tax.rate}%${inv.tax.inclusive ? " (included)" : ""}`, fmtMoney(inv.tax.amount, inv.currency));
  total("Total", fmtMoney(inv.total, inv.currency), true);
  total("Amount paid", fmtMoney(inv.amountPaid, inv.currency));
  if (inv.balanceDue > 0) total("Balance due", fmtMoney(inv.balanceDue, inv.currency), true);
  const refunded = round(refunds.reduce((s, r) => s + r.amount, 0), inv.currency);
  if (refunded > 0) {
    y -= 6;
    for (const r of refunds) total(`Refunded ${day(r.at)}`, `-${fmtMoney(r.amount, r.currency)}`);
    total("Net paid", fmtMoney(round(inv.amountPaid - refunded, inv.currency), inv.currency), true);
  }
  text(page, `All amounts in ${inv.currency}${inv.currency === "ESP" ? " (Espees)" : ""}.`, 50, 8, font, grey);

  y = 60;
  for (const l of lines(inv.seller.footer).slice(0, 3)) {
    text(page, l, 50, 8, font, grey);
    y -= 11;
  }
  return doc.save();
}

// src/lib/finance/export.ts
//
// Financial reports as CSV or Excel: payments, refunds, and revenue by
// period. Every money column sits next to a currency column, and the
// revenue report has one row per period AND currency — nothing is summed
// across currencies, in the file or in a total row.

import ExcelJS from "exceljs";
import { currenciesOf } from "@/lib/finance/money";
import type { LedgerEntry } from "@/lib/finance/ledger";
import type { SeriesPoint } from "@/lib/finance/revenue";

export type ReportType = "payments" | "refunds" | "revenue";

type Cell = string | number | null;
export interface Table {
  name: string;
  head: string[];
  /** Columns holding money, formatted as numbers with 2 decimals in Excel. */
  money: number[];
  rows: Cell[][];
}

const iso = (t: number | undefined) => (t ? new Date(t).toISOString() : "");

export function paymentsTable(items: LedgerEntry[]): Table {
  return {
    name: "Payments",
    head: ["paid at (UTC)", "reference", "invoice", "provider", "kind", "description", "plan", "cycle", "user id", "email", "amount", "currency", "status", "refunded", "verified with provider", "period start", "period end", "failure reason"],
    money: [10, 13],
    rows: items.map((e) => [
      iso(e.at),
      e.ref,
      e.invoiceNumber ?? "",
      e.provider,
      e.kind,
      e.description,
      e.plan ?? "",
      e.cycle ?? "",
      e.userId ?? "",
      e.email ?? "",
      e.amount,
      e.currency,
      e.status,
      e.refundedAmount,
      e.verified ? "yes" : "no",
      iso(e.periodStart),
      iso(e.periodEnd),
      e.failureReason ?? "",
    ]),
  };
}

export function refundsTable(items: LedgerEntry[], from = 0, to = Number.MAX_SAFE_INTEGER): Table {
  const rows: Cell[][] = [];
  for (const e of items) {
    for (const r of e.refunds) {
      if (r.at < from || r.at > to) continue;
      rows.push([iso(r.at), e.ref, e.invoiceNumber ?? "", e.provider, e.description, e.userId ?? "", e.email ?? "", r.amount, r.currency, r.method === "stripe" ? "Stripe API" : "outside NeoConference", r.providerRef ?? "", r.providerStatus ?? "", r.reason ?? "", r.byEmail, r.downgraded ? "yes" : "no"]);
    }
  }
  rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  return {
    name: "Refunds",
    head: ["refunded at (UTC)", "payment reference", "invoice", "provider", "description", "user id", "email", "amount", "currency", "how", "refund reference", "provider status", "reason", "by", "plan ended"],
    money: [7],
    rows,
  };
}

export function revenueTable(points: SeriesPoint[]): Table {
  const rows: Cell[][] = [];
  for (const p of points) {
    const cs = currenciesOf(p.gross, p.refunds);
    for (const c of cs) {
      const g = p.gross[c] ?? 0;
      const r = p.refunds[c] ?? 0;
      rows.push([p.label, c, g, r, Math.round((g - r) * 100) / 100]);
    }
  }
  return { name: "Revenue", head: ["period (UTC)", "currency", "gross", "refunds", "net"], money: [2, 3, 4], rows };
}

function csvCell(v: Cell): string {
  const s = v == null ? "" : String(v);
  // A leading = + - @ would run as a formula in a spreadsheet. Negative
  // numbers are written as numbers, so only text is prefixed.
  const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(t: Table): string {
  return [t.head, ...t.rows].map((r) => r.map((c) => csvCell(c)).join(",")).join("\r\n");
}

export async function toXlsx(t: Table): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NeoConference";
  wb.created = new Date();
  const ws = wb.addWorksheet(t.name);
  ws.addRow(t.head).font = { bold: true };
  for (const r of t.rows) {
    // Text cells that look like formulas stay text: ExcelJS writes strings as strings.
    ws.addRow(r.map((c) => (c == null ? "" : c)));
  }
  for (const i of t.money) ws.getColumn(i + 1).numFmt = "#,##0.00";
  ws.columns.forEach((col, i) => {
    col.width = Math.min(40, Math.max(10, t.head[i]?.length ?? 10, ...t.rows.slice(0, 200).map((r) => String(r[i] ?? "").length)));
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

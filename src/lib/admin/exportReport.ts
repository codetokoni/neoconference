// src/lib/admin/exportReport.ts
//
// Admin reports as files: CSV (one table) or Excel (one sheet per table).
// Cells that would run as a formula in a spreadsheet (= + - @ at the start)
// are prefixed with a quote, as the audit-log CSV does.

import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

export interface Column {
  header: string;
  key: string;
  width?: number;
}

export interface Table {
  name: string;
  columns: Column[];
  rows: Array<Record<string, unknown>>;
}

function text(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

/** A string that starts like a formula, made inert. Numbers are left alone. */
function inert(v: unknown): string | number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = text(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function csvOf(t: Table): string {
  const cell = (v: unknown) => {
    const s = String(inert(v));
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [t.columns.map((c) => cell(c.header)).join(",")];
  for (const r of t.rows) lines.push(t.columns.map((c) => cell(r[c.key])).join(","));
  return lines.join("\r\n");
}

export async function xlsxOf(tables: Table[]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NeoConference";
  wb.created = new Date();
  for (const t of tables) {
    const sheet = wb.addWorksheet(t.name.slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
    sheet.columns = t.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(10, c.header.length + 2) }));
    sheet.getRow(1).font = { bold: true };
    for (const r of t.rows) {
      const out: Record<string, string | number> = {};
      for (const c of t.columns) out[c.key] = inert(r[c.key]);
      sheet.addRow(out);
    }
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export function fileSafe(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "report";
}

export function csvResponse(t: Table, filename: string): NextResponse {
  // A BOM so Excel opens UTF-8 names correctly.
  return new NextResponse("﻿" + csvOf(t), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fileSafe(filename)}.csv"`,
    },
  });
}

export async function xlsxResponse(tables: Table[], filename: string): Promise<NextResponse> {
  const buf = await xlsxOf(tables);
  return new NextResponse(buf, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${fileSafe(filename)}.xlsx"`,
    },
  });
}

/** A timestamp in `tz` as "YYYY-MM-DD HH:MM:SS", for a column headed with the zone. */
export function zonedStamp(ts: number | null | undefined, tz: string): string {
  if (!ts) return "";
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts)))
    p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

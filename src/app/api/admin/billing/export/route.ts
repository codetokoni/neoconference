// GET /api/admin/billing/export — financial reports as files
// (billing:read + reports:export).
//
// type   payments | refunds | revenue
// format csv | xlsx
// Filters as /api/admin/billing/payments (payments and refunds), and
// from, to, bucket for revenue. Every amount has its currency next to it;
// revenue is one row per period and currency. Recorded in the audit log.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import { recordAdminAction } from "@/lib/admin/audit";
import { entriesBetween, queryLedger } from "@/lib/finance/ledger";
import { ledgerQuery, timeParam } from "@/lib/finance/query";
import { DAY, autoBucket, series, type Bucket } from "@/lib/finance/revenue";
import { paymentsTable, refundsTable, revenueTable, toCsv, toXlsx, type Table } from "@/lib/finance/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, ["billing:read", "reports:export"]);
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const type = p.get("type");
  const format = p.get("format") === "xlsx" ? "xlsx" : "csv";
  let table: Table;
  if (type === "payments") {
    const q = ledgerQuery(p);
    table = paymentsTable((await queryLedger({ ...q, offset: 0, limit: 500_000 })).items);
  } else if (type === "refunds") {
    // Refunds are dated by when they were made, which can be after the payment.
    const q = ledgerQuery(p);
    const all = await queryLedger({ ...q, from: undefined, to: undefined, status: "refunds", offset: 0, limit: 500_000 });
    table = refundsTable(all.items, q.from, q.to);
  } else if (type === "revenue") {
    const now = Date.now();
    const to = Math.min(timeParam(p.get("to"), true) ?? now, now);
    const from = timeParam(p.get("from"), false) ?? to - 365 * DAY + 1;
    const b = p.get("bucket");
    const bucket: Bucket = b === "day" || b === "week" || b === "month" ? b : autoBucket(from, to);
    table = revenueTable(series(await entriesBetween(from, to), from, to, bucket));
  } else {
    return fail("bad_type", "type must be payments, refunds or revenue.");
  }

  await recordAdminAction(actorOf(g.ctx), req, {
    action: "billing.export",
    targetType: "report",
    targetId: `${type}.${format}`,
    targetLabel: `${table.name} (${format.toUpperCase()})`,
    after: { rows: table.rows.length, filters: Object.fromEntries([...p.entries()].filter(([k]) => k !== "format" && k !== "type")) },
  });

  const name = `neoconference-${type}-${new Date().toISOString().slice(0, 10)}.${format}`;
  if (format === "xlsx") {
    return new NextResponse(await toXlsx(table), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
  }
  return new NextResponse(toCsv(table), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}

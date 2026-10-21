// GET /api/partner/v1/reports/zones/:zone/export?period=month — the zone's
// participant table as CSV, for its leaders and the organisation's
// administrators. Times are given in the report's timezone (named in the
// column titles) and in UTC.

import { NextRequest, NextResponse } from "next/server";
import { fail } from "@/lib/partners/http";
import { buildReport, reportCsv } from "@/lib/partners/reports";
import { partnerCaller, periodOf, requireZoneReader, zoneOf } from "@/lib/partners/reportAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { zone: string } }) {
  try {
    const { integration, viewerId } = await partnerCaller(req);
    const zone = await zoneOf(integration, params.zone);
    await requireZoneReader(integration, zone, viewerId);
    const now = Date.now();
    const period = periodOf(req, integration, now);
    const r = await buildReport({ integration, zones: [zone], period, now });
    const name = `prayer-${zone.zoneId}-${period.kind}-${r.period.from.slice(0, 10)}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
    // A byte-order mark so spreadsheet apps read names as UTF-8.
    return new NextResponse("﻿" + reportCsv(r), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return fail(e);
  }
}

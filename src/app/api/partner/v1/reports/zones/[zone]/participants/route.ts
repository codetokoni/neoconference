// GET /api/partner/v1/reports/zones/:zone/participants?period=week&page=1&pageSize=50
// — the zone's participant table for its leaders and the organisation's
// administrators: name, the partner's user id, first joined, last left,
// sessions attended, prayer time and whether they are connected now, most
// prayer time first. pageSize up to 200.

import { NextRequest } from "next/server";
import { fail } from "@/lib/partners/http";
import { buildReport, reportTag } from "@/lib/partners/reports";
import { partnerCaller, periodOf, requireZoneReader, tagged, zoneOf } from "@/lib/partners/reportAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { zone: string } }) {
  try {
    const { integration, viewerId } = await partnerCaller(req);
    const zone = await zoneOf(integration, params.zone);
    await requireZoneReader(integration, zone, viewerId);
    const now = Date.now();
    const period = periodOf(req, integration, now);
    const q = req.nextUrl.searchParams;
    const pageSize = Math.min(200, Math.max(1, Number(q.get("pageSize")) || 50));
    const page = Math.max(1, Math.floor(Number(q.get("page")) || 1));
    const tag = `${await reportTag(integration.id, [zone.zoneId], now)}-p${page}x${pageSize}`;
    return tagged(req, tag, async () => {
      const r = await buildReport({ integration, zones: [zone], period, now });
      const total = r.participants.length;
      return {
        zone: r.zones[0],
        period: r.period,
        page,
        pageSize,
        total,
        pages: Math.max(1, Math.ceil(total / pageSize)),
        participants: r.participants.slice((page - 1) * pageSize, page * pageSize).map(({ zones: _z, ...p }) => {
          void _z;
          return p;
        }),
        generatedAt: r.generatedAt,
      };
    });
  } catch (e) {
    return fail(e);
  }
}

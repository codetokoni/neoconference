// GET /api/partner/v1/reports/zones/:zone?period=today — a zone's prayer
// report for its leaders and the organisation's administrators: the
// summary (sessions, unique participants, connected now, total and average
// prayer time) and every session with its own duration. The participant
// table is /participants (paginated); one session is /sessions/:id.
//
//   Authorization: Bearer nlm_pk_…   X-Viewer-Id: <a leader of this zone, or an org admin>
//   ETag / If-None-Match: 304 while nothing has changed.

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
    return tagged(req, await reportTag(integration.id, [zone.zoneId], now), async () => {
      const r = await buildReport({ integration, zones: [zone], period, now });
      return { zone: r.zones[0], period: r.period, summary: r.summary, sessions: r.sessions, generatedAt: r.generatedAt };
    });
  } catch (e) {
    return fail(e);
  }
}

// GET /api/partner/v1/reports/org?period=month — the whole organisation,
// for its administrators: one summary across every zone (a person in two
// zones at once counts once) and each zone's own summary.

import { NextRequest } from "next/server";
import { fail } from "@/lib/partners/http";
import { buildReport, reportTag } from "@/lib/partners/reports";
import { partnerCaller, periodOf, requireOrgAdmin, tagged } from "@/lib/partners/reportAccess";
import { listZones } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { integration, viewerId } = await partnerCaller(req);
    await requireOrgAdmin(integration, viewerId);
    const zones = await listZones(integration.id);
    const now = Date.now();
    const period = periodOf(req, integration, now);
    return tagged(req, `${await reportTag(integration.id, zones.map((z) => z.zoneId), now)}-org`, async () => {
      const all = await buildReport({ integration, zones, period, now });
      const perZone = await Promise.all(
        zones.map(async (z) => {
          const r = await buildReport({ integration, zones: [z], period, now });
          return { zone: r.zones[0], summary: r.summary };
        }),
      );
      return { period: all.period, summary: all.summary, zones: perZone, generatedAt: all.generatedAt };
    });
  } catch (e) {
    return fail(e);
  }
}

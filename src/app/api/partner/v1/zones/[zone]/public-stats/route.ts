// GET /api/partner/v1/zones/:zone/public-stats?period=today — the figures a
// zone's public page may show: only those the integration switched on
// (Admin > Partner zones), never a name or anyone's own time. No viewer.
// period: current, today, week or month.

import { NextRequest } from "next/server";
import { fail } from "@/lib/partners/http";
import { buildReport, reportTag } from "@/lib/partners/reports";
import { partnerCaller, periodOf, tagged, zoneOf } from "@/lib/partners/reportAccess";
import { PartnerError } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { zone: string } }) {
  try {
    const { integration } = await partnerCaller(req);
    const zone = await zoneOf(integration, params.zone);
    if (zone.status !== "active") throw new PartnerError(403, "zone_disabled", "This zone's meeting is switched off.");
    const now = Date.now();
    const period = periodOf(req, integration, now);
    if (period.kind === "custom") throw new PartnerError(400, "invalid_period", "Public figures are for current, today, week or month.");
    const enabled = integration.publicStats ?? [];
    return tagged(req, `${await reportTag(integration.id, [zone.zoneId], now)}-pub-${enabled.join(".")}`, async () => {
      const stats: Record<string, number> = {};
      if (enabled.length) {
        const r = await buildReport({ integration, zones: [zone], period, now });
        for (const k of enabled) stats[k] = r.summary[k];
      }
      return { zone: { zoneId: zone.zoneId, name: zone.title }, period: { kind: period.kind, label: period.label, timezone: period.timezone }, stats, generatedAt: new Date(now).toISOString() };
    });
  } catch (e) {
    return fail(e);
  }
}

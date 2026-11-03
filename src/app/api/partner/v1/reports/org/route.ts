// GET /api/partner/v1/reports/org?period=month — the whole organisation,
// for its administrators: one summary across every zone (a person in two
// zones at once counts once) and each zone's own summary.

import { NextRequest } from "next/server";
import { fail } from "@/lib/partners/http";
import { orgReport, orgReportTag } from "@/lib/partners/orgTotals";
import { partnerCaller, periodOf, requireOrgAdmin, tagged } from "@/lib/partners/reportAccess";
import { listZones } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A day not stored yet is worked out on the spot (the nightly job normally has).
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  try {
    const { integration, viewerId } = await partnerCaller(req);
    await requireOrgAdmin(integration, viewerId);
    const now = Date.now();
    const period = periodOf(req, integration, now);
    // From day totals (src/lib/partners/orgTotals.ts): built zone by zone
    // it could not finish for a partner with thousands of zones.
    return tagged(req, await orgReportTag(integration.id, period, now), async () => orgReport(integration, await listZones(integration.id), period, now));
  } catch (e) {
    return fail(e);
  }
}

// GET /api/admin/partners/[id]/zones/[zone]/report?period=today
// (integrations:write, read-only): the zone's prayer report as its leaders
// see it — summary, sessions and the first 100 participants — for
// NeoLinguaMeet's administrators checking a partner's numbers.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { adminFail } from "@/lib/partners/admin";
import { buildReport, resolvePeriod } from "@/lib/partners/reports";
import { PartnerError, getIntegration, getZone, normalizeZone, reportTimezone } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string; zone: string } }) {
  const g = await requireAdmin(req, "integrations:write", { readOnly: true });
  if (!g.ok) return g.response;
  try {
    const integration = await getIntegration(params.id);
    if (!integration) throw new PartnerError(404, "integration_not_found", "No such integration.");
    const zoneId = normalizeZone(decodeURIComponent(params.zone));
    const zone = zoneId ? await getZone(integration.id, zoneId) : null;
    if (!zone) throw new PartnerError(404, "zone_not_found", "No such zone.");
    const q = new URL(req.url).searchParams;
    const now = Date.now();
    const period = resolvePeriod({ period: q.get("period"), from: q.get("from"), to: q.get("to") }, reportTimezone(integration), now);
    const r = await buildReport({ integration, zones: [zone], period, now });
    return NextResponse.json({
      ok: true,
      zone: r.zones[0],
      period: r.period,
      summary: r.summary,
      sessions: r.sessions,
      participants: r.participants.slice(0, 100),
      totalParticipants: r.participants.length,
      generatedAt: r.generatedAt,
    });
  } catch (e) {
    return adminFail(e);
  }
}

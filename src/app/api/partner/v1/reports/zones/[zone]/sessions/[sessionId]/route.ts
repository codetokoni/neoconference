// GET /api/partner/v1/reports/zones/:zone/sessions/:sessionId — one prayer
// session in full, for the zone's leaders and the organisation's
// administrators: when it ran and for how long, and each participant with
// their connected intervals and counted prayer time in it.

import { NextRequest } from "next/server";
import { fail } from "@/lib/partners/http";
import { getSession } from "@/lib/partners/attendance";
import { buildReport, reportTag } from "@/lib/partners/reports";
import { partnerCaller, requireZoneReader, tagged, zoneOf } from "@/lib/partners/reportAccess";
import { PartnerError, reportTimezone } from "@/lib/partners/store";
import { participantIdentity } from "@/lib/partners/join";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { zone: string; sessionId: string } }) {
  try {
    const { integration, viewerId } = await partnerCaller(req);
    const zone = await zoneOf(integration, params.zone);
    await requireZoneReader(integration, zone, viewerId);
    const s = /^ps_[a-f0-9]{16}$/.test(params.sessionId) ? await getSession(params.sessionId) : null;
    // Another zone's (or partner's) session is not found here.
    if (!s || s.integrationId !== integration.id || s.zoneId !== zone.zoneId) throw new PartnerError(404, "session_not_found", "No such session in this zone.");
    const now = Date.now();
    const timezone = reportTimezone(integration);
    return tagged(req, `${await reportTag(integration.id, [zone.zoneId], now)}-${s.id}`, async () => {
      const r = await buildReport({
        integration,
        zones: [zone],
        period: { kind: "custom", from: s.startedAt, to: (s.endedAt ?? now) + 1, timezone, label: s.id },
        now,
        onlySession: s.id,
      });
      return {
        zone: r.zones[0],
        timezone,
        session: r.sessions[0] ?? null,
        participants: r.participants.map(({ zones: _z, ...p }) => {
          void _z;
          const identity = participantIdentity({ integrationId: integration.id, externalUserId: `${p.guest ? "guest" : "user"}:${p.userId}` });
          return { ...p, intervals: r.intervals.get(identity) ?? [] };
        }),
        generatedAt: r.generatedAt,
      };
    });
  } catch (e) {
    return fail(e);
  }
}

// GET /api/partner/v1/attendance/me?zoneId=FALF&period=today — the person
// looking (X-Viewer-Id), their own prayer time in a zone: the live timer
// for the current session, and their attendance in the period, session by
// session with each counted interval. Nobody else's.
//
//   Authorization: Bearer nlm_pk_…   X-Viewer-Id: <the partner's user id>
//   period: current | today | week | month | custom (&from=YYYY-MM-DD&to=YYYY-MM-DD)

import { NextRequest } from "next/server";
import { fail } from "@/lib/partners/http";
import { participantIdentity } from "@/lib/partners/join";
import { timerSummary } from "@/lib/partners/attendance";
import { buildReport, reportTag } from "@/lib/partners/reports";
import { partnerCaller, periodOf, requireViewer, tagged, zoneOf } from "@/lib/partners/reportAccess";
import { PartnerError } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { integration, viewerId } = await partnerCaller(req);
    const viewer = requireViewer(viewerId);
    const zoneParam = req.nextUrl.searchParams.get("zoneId");
    if (!zoneParam) throw new PartnerError(400, "invalid_zone", "zoneId is required.");
    const zone = await zoneOf(integration, zoneParam);
    const now = Date.now();
    const period = periodOf(req, integration, now);
    const identity = participantIdentity({ integrationId: integration.id, externalUserId: `user:${viewer}` });
    const tag = `${await reportTag(integration.id, [zone.zoneId], now)}-me`;
    return tagged(req, tag, async () => {
      const r = await buildReport({ integration, zones: [zone], period, now, onlyIdentity: identity });
      const me = r.participants[0] ?? null;
      const timer = await timerSummary(integration.id, zone.zoneId, identity, now);
      return {
        viewer: { userId: viewer },
        zone: r.zones[0],
        period: r.period,
        timer,
        attendance: {
          prayerSeconds: me?.prayerSeconds ?? 0,
          sessionsAttended: me?.sessionsAttended ?? 0,
          firstJoined: me?.firstJoined ?? null,
          lastLeft: me?.lastLeft ?? null,
          connected: me?.connected ?? false,
          sessions: r.sessions
            .filter((s) => s.participants > 0)
            .map((s) => ({
              id: s.id,
              startedAt: s.startedAt,
              endedAt: s.endedAt,
              durationSeconds: s.durationSeconds,
              prayerSeconds: s.prayerSeconds,
              intervals: (r.intervals.get(identity) ?? []).filter((i) => i.end > s.startedAt && (s.endedAt == null || i.start < s.endedAt)),
            })),
        },
        generatedAt: r.generatedAt,
      };
    });
  } catch (e) {
    return fail(e);
  }
}

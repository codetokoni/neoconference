// GET /api/partner/v1/zones/:zone/leaders — the zone's leaders.
// PUT /api/partner/v1/zones/:zone/leaders { leaders: ["u_1", …] } — replace them.
//
// The partner's own user ids. A zone's leaders read that zone's reports
// and participant table, and no other zone's.

import { NextRequest } from "next/server";
import { fail, ok, readJson } from "@/lib/partners/http";
import { partnerCaller, zoneOf } from "@/lib/partners/reportAccess";
import { getZoneLeaders, setZoneLeaders } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { zone: string } }) {
  try {
    const { integration } = await partnerCaller(req);
    const zone = await zoneOf(integration, params.zone);
    return ok({ zoneId: zone.zoneId, leaders: await getZoneLeaders(integration.id, zone.zoneId) });
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(req: NextRequest, { params }: { params: { zone: string } }) {
  try {
    const { integration } = await partnerCaller(req);
    const zone = await zoneOf(integration, params.zone);
    const body = await readJson(req);
    return ok({ zoneId: zone.zoneId, leaders: await setZoneLeaders(integration.id, zone.zoneId, body.leaders, "partner") });
  } catch (e) {
    return fail(e);
  }
}

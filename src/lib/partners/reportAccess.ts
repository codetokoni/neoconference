// src/lib/partners/reportAccess.ts — who may read which partner report.
//
// Every report route is called by the partner's SERVER with its key, and
// names the person looking in the X-Viewer-Id header (the partner's own
// user id for them). What that person may see is decided here, from the
// lists NeoLinguaMeet keeps (store.ts: organisation administrators, zone
// leaders) — never from the zone a page asked for:
//   - anyone: their own attendance (/attendance/me);
//   - a zone's leaders: that zone's reports;
//   - organisation administrators: every zone, and the organisation report;
//   - nobody (no viewer): only the aggregate figures the integration made
//     public, for a zone's public page.

import { NextRequest, NextResponse } from "next/server";
import { PartnerError, authenticatePartner, cleanUserId, getZone, normalizeZone, reportTimezone, viewerRoles, type PartnerIntegration, type ZoneMapping } from "@/lib/partners/store";
import { limit } from "@/lib/partners/http";
import { resolvePeriod, type Period } from "@/lib/partners/reports";

export const VIEWER_HEADER = "x-viewer-id";

export async function partnerCaller(req: NextRequest): Promise<{ integration: PartnerIntegration; viewerId: string | null }> {
  const { integration, keyId } = await authenticatePartner(req.headers.get("authorization"));
  await limit(`reports:${keyId}`, 600);
  if (integration.status !== "active") throw new PartnerError(403, "integration_disabled", "This integration is disabled.");
  const raw = req.headers.get(VIEWER_HEADER);
  const viewerId = raw == null ? null : cleanUserId(raw);
  if (raw != null && !viewerId) throw new PartnerError(400, "invalid_viewer", `${VIEWER_HEADER}: the partner's user id for the person looking.`);
  return { integration, viewerId };
}

export function requireViewer(viewerId: string | null): string {
  if (!viewerId) throw new PartnerError(400, "viewer_required", `Name the person looking in ${VIEWER_HEADER}.`);
  return viewerId;
}

/** A zone of this integration (another partner's zone of the same name is not it). */
export async function zoneOf(integration: PartnerIntegration, raw: string): Promise<ZoneMapping> {
  const zone = normalizeZone(decodeURIComponent(raw));
  const mapping = zone ? await getZone(integration.id, zone) : null;
  if (!mapping) throw new PartnerError(404, "zone_not_found", "No such zone.");
  return mapping;
}

/** The viewer leads this zone or administers the organisation. */
export async function requireZoneReader(integration: PartnerIntegration, zone: ZoneMapping, viewerId: string | null): Promise<void> {
  const roles = await viewerRoles(integration.id, requireViewer(viewerId));
  if (!roles.orgAdmin && !roles.leads.includes(zone.zoneId)) {
    throw new PartnerError(403, "not_authorised", "This person may not see this zone's reports.");
  }
}

export async function requireOrgAdmin(integration: PartnerIntegration, viewerId: string | null): Promise<void> {
  const roles = await viewerRoles(integration.id, requireViewer(viewerId));
  if (!roles.orgAdmin) throw new PartnerError(403, "not_authorised", "Only the organisation's administrators see this report.");
}

export function periodOf(req: NextRequest, integration: PartnerIntegration, now = Date.now()): Period {
  const q = req.nextUrl.searchParams;
  return resolvePeriod({ period: q.get("period"), from: q.get("from"), to: q.get("to") }, reportTimezone(integration), now);
}

/** JSON with the report's change tag; "304 Not Modified" when the caller already has it. */
export async function tagged(req: NextRequest, tag: string, build: () => Promise<unknown>): Promise<NextResponse> {
  const headers = { "cache-control": "private, no-cache", etag: tag, "referrer-policy": "no-referrer" };
  if (req.headers.get("if-none-match") === tag) return new NextResponse(null, { status: 304, headers });
  return NextResponse.json(await build(), { headers });
}

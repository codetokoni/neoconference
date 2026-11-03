// src/app/api/cron/partner-totals/route.ts
//
// Nightly (vercel.json): stores each partner's finished days of prayer
// totals (src/lib/partners/orgTotals.ts), so the organisation report reads a
// month as thirty small records instead of every session in it. Fills any
// day of the last 35 not stored yet; a day already stored is left alone, so
// running it again does nothing more. Auth as the other crons.

import { NextResponse, type NextRequest } from "next/server";
import { isCronRequest, cronRoute } from "@/lib/ops/cron";
import { storeFinishedDays } from "@/lib/partners/orgTotals";
import { listIntegrations, listZones, reportTimezone } from "@/lib/partners/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = Date.now();
  const done: { integrationId: string; days: number }[] = [];
  const errors: { integrationId: string; error: string }[] = [];
  for (const integration of await listIntegrations()) {
    if (integration.status !== "active") continue;
    try {
      const days = await storeFinishedDays(integration, await listZones(integration.id), reportTimezone(integration), now);
      done.push({ integrationId: integration.id, days });
    } catch (e) {
      console.error("[cron/partner-totals]", integration.id, e);
      errors.push({ integrationId: integration.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ ok: errors.length === 0, done, errors }, { status: errors.length ? 500 : 200 });
}

export const GET = cronRoute("partner-totals", handle);

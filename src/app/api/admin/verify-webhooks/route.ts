// src/app/api/admin/verify-webhooks/route.ts
//
// GET — read the LiveKit webhook activity counters so an admin can verify
// which subscriptions are actually firing from LiveKit Cloud.
//
// Used by docs/runbooks/setup-livekit-webhooks.md — after enabling the
// participant_joined / participant_left events in the LiveKit Cloud
// dashboard the runbook triggers a test meeting, then hits this endpoint
// and expects the counters for those two events to be non-zero within
// the last few minutes.
//
// Platform-admin gated.

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/roles";
import { readWebhookMetrics, type WebhookMetric } from "@/lib/webhookMetrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The four events FRS §2/§4 rely on. If any of these are silent after
// a test meeting the runbook nudges the admin back to the LiveKit
// subscription list.
const REQUIRED: Array<WebhookMetric["event"]> = [
  "room_started",
  "room_finished",
  "participant_joined",
  "participant_left",
];

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const u = await currentUser().catch(() => null);
  const emails = (u?.emailAddresses || []).map(
    (e: { emailAddress: string }) => e.emailAddress.toLowerCase(),
  );
  if (!emails.some((e) => isAdmin(e))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const metrics = await readWebhookMetrics();
  const byEvent = new Map(metrics.map((m) => [m.event, m]));

  const missing = REQUIRED.filter((event) => {
    const m = byEvent.get(event);
    return !m || m.count === 0;
  });

  const now = Date.now();
  const staleThresholdMs = 24 * 60 * 60 * 1000;
  const stale = REQUIRED.filter((event) => {
    const m = byEvent.get(event);
    if (!m || m.count === 0) return false; // "missing" catches that
    return m.lastAtMs === null || now - m.lastAtMs > staleThresholdMs;
  });

  return NextResponse.json({
    ok: true,
    healthy: missing.length === 0 && stale.length === 0,
    missing,
    stale,
    metrics,
    generatedAt: now,
  });
}

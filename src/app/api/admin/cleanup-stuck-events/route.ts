// src/app/api/admin/cleanup-stuck-events/route.ts
//
// Run the stale-meeting reconciliation on demand. Admin-gated, POST only.
//
// This used to hold its own copy of the algorithm and was described as a
// one-time backfill for events stuck 'live' from before the
// room_finished webhook existed. It was neither: the same events kept
// getting stuck, because a webhook can be missed for reasons nothing in
// this codebase controls, and nothing ever ran this endpoint again.
//
// The logic now lives in src/lib/meetingLifecycle.ts and runs
// automatically — throttled — whenever someone lists their meetings. This
// endpoint stays as the manual lever: it ignores the throttle, so an
// admin can force a sweep and read the summary rather than waiting for
// the next window.
//
// `graceMs` may be passed in the body to override how long a meeting must
// have been open before an absent LiveKit room is taken as proof it
// finished. Sent as milliseconds; omit it for the default hour.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { runMeetingSweep } from "@/lib/meetingSweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const caller = await requireRole(["admin"]);
  if (!caller) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let graceMs: number | undefined;
  try {
    const body = (await req.json()) as { graceMs?: unknown };
    if (typeof body?.graceMs === "number" && Number.isFinite(body.graceMs)) {
      graceMs = Math.max(0, body.graceMs);
    }
  } catch {
    // No body is the normal case.
  }

  const summary = await runMeetingSweep({ graceMs });

  // A failed LiveKit lookup changes nothing, and the caller should hear
  // about that as a failure rather than as "swept, found none".
  return NextResponse.json(summary, { status: summary.ok ? 200 : 502 });
}

// /api/cron/comms — announcements with recipients left (src/lib/comms/sends.ts).
//
// The scheduler's 30-second tick (/api/internal/dispatch) does this all day;
// this daily Vercel cron is the backstop if that container is down.
// Same gate as the other crons: Authorization: Bearer <CRON_SECRET>.

import { NextResponse } from "next/server";
import { authorizedDispatch } from "@/lib/dispatchAuth";
import { runCommsDispatch } from "@/lib/comms/sends";
import { cronRoute } from "@/lib/ops/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  if (!authorizedDispatch(req.headers.get("authorization"), [process.env.CRON_SECRET, process.env.DISPATCH_SECRET])) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runCommsDispatch(50_000), { headers: { "cache-control": "no-store" } });
}

// Recorded and locked by the ops job runner (Operations > Jobs); the
// schedule and what the route does are unchanged.
export const GET = cronRoute<Request>("comms", handle);

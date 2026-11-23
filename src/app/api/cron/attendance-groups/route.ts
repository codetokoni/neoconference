// src/app/api/cron/attendance-groups/route.ts
//
// Every 10 minutes (vercel.json): sends the attendance by church or group of
// every meeting session that ended at least five minutes ago
// (src/lib/attendanceGroups.ts sendDue). Each session once. Auth as the
// other crons; also runs from Admin → Operations → Jobs.

import { NextResponse, type NextRequest } from "next/server";
import { isCronRequest, cronRoute } from "@/lib/ops/cron";
import { sendDue } from "@/lib/attendanceGroups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, ...(await sendDue()) });
}

export const GET = cronRoute("attendance-groups", handle);

// src/app/api/cron/billing-reminders/route.ts
//
// Daily billing reminders (vercel.json): failed payments, abandoned
// checkouts and plans coming up for renewal, by the rules on the admin
// Billing settings page. All off until an administrator turns them on.
// Auth mirrors the other crons: Bearer CRON_SECRET, or Vercel's cron header
// when no secret is set. Each reminder goes out once at most, however
// often this runs (src/lib/finance/reminders.ts).

import { NextResponse, type NextRequest } from "next/server";
import { runReminders } from "@/lib/finance/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // If unset, only allow when Vercel marks the request as cron-driven.
    return req.headers.get("x-vercel-cron") === "1";
  }
  const auth = req.headers.get("authorization") || "";
  return auth === "Bearer " + secret;
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runReminders(Date.now(), { by: "cron" });
  return NextResponse.json({ ok: true, ...result });
}

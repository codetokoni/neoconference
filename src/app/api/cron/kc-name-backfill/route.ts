// src/app/api/cron/kc-name-backfill/route.ts
//
// Every 10 minutes (vercel.json) until it is done: fills in the KingsChat
// name of accounts that signed in before names were kept, a batch per run
// (src/lib/kcNameBackfill.ts). Once a run finds no one left, later runs only
// check that and stop. Auth as the other crons; also runs from Admin →
// Operations → Jobs.

import { NextResponse, type NextRequest } from "next/server";
import { isCronRequest, cronRoute } from "@/lib/ops/cron";
import { backfillKcNames } from "@/lib/kcNameBackfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await backfillKcNames({ budgetMs: 240_000 });
  return NextResponse.json(r);
}

export const GET = cronRoute("kc-name-backfill", handle);

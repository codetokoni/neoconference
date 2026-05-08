// src/app/api/recordings/analytics/route.ts
// GET   - owner-only: returns stats for a recording prefix or specific keys.
// POST  - public: bump a metric (views/downloads/shares) for a key.
//                 Best-effort, anti-spam guard via referrer + content-type only.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { recordingAnalytics, type RecordingMetric } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_METRICS: RecordingMetric[] = ["views", "downloads", "shares"];

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const keysParam = url.searchParams.get("keys");
  if (!keysParam) {
    return NextResponse.json({ ok: true, stats: {} });
  }
  const keys = keysParam.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 200);
  const stats = await recordingAnalytics.getStatsBatch(keys);
  return NextResponse.json({ ok: true, stats });
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const metric = typeof body.metric === "string" ? body.metric : "";
  const key = typeof body.key === "string" ? body.key : "";
  if (!key || key.includes("..")) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }
  if (!VALID_METRICS.includes(metric as RecordingMetric)) {
    return NextResponse.json({ error: "invalid_metric" }, { status: 400 });
  }
  const next = await recordingAnalytics.bump(metric as RecordingMetric, key);
  return NextResponse.json({ ok: true, count: next });
}

// src/app/api/cron/ops-backup/route.ts
//
// Daily (vercel.json): snapshot the KV store into R2, verify it, and keep
// the newest KEEP_SNAPSHOTS. See src/lib/ops/backup.ts. Run through the ops
// job runner. Auth as the other cron routes.

import { NextResponse, type NextRequest } from "next/server";
import { cronRoute, isCronRequest } from "@/lib/ops/cron";
import { applyRetention, createSnapshot } from "@/lib/ops/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const by = req.headers.get("x-neo-job-actor") || "vercel-cron";
  const manual = (req.headers.get("x-neo-job-trigger") || "schedule") !== "schedule";
  const snap = await createSnapshot({ kind: manual ? "manual" : "scheduled", by });
  const removed = await applyRetention();
  const ok = !!snap.verify?.ok && !snap.truncated;
  return NextResponse.json(
    {
      ok,
      id: snap.id,
      keys: snap.keyCount,
      bytes: snap.bytes,
      verified: snap.verify?.ok ?? false,
      ...(snap.truncated ? { error: `incomplete: ${snap.truncatedReason}` } : !ok ? { error: snap.verify?.detail } : {}),
      retentionRemoved: removed.length,
    },
    { status: ok ? 200 : 500 },
  );
}

export const GET = cronRoute("ops-backup", handle, { lockMs: 10 * 60 * 1000 });

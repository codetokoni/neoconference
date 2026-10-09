// /api/admin/ops/media — media pipeline health (ops:read): uploads and
// recordings per day with recent failures, transcription success/failure,
// AMS streams live against expected, translation worker errors.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { mediaSummary } from "@/lib/ops/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  const days = Math.max(1, Math.min(30, Number(new URL(req.url).searchParams.get("days")) || 7));
  return NextResponse.json({ ok: true, ...(await mediaSummary(days)) });
}

// GET /api/admin/integrations (integrations:write, no fresh code to look)
//
// Every outside service the code uses: configured or not, judged by which
// environment variables are present, with a fingerprint of each value —
// never the value. Secrets in environment variables are rotated at the
// provider and in Vercel, not here; the response carries the steps.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { ROTATION_DOCS, ROTATION_STEPS, integrationStatuses } from "@/lib/platform/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "integrations:write", { readOnly: true });
  if (!g.ok) return g.response;
  return NextResponse.json({
    ok: true,
    integrations: integrationStatuses(),
    rotation: { steps: ROTATION_STEPS, docs: ROTATION_DOCS },
    environment: process.env.VERCEL_ENV || "development",
  });
}

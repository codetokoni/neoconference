// GET /api/platform/logo — the platform logo uploaded in /admin/settings.
// Public (the header shows it to everyone). Redirects to a short-lived
// signed R2 address; the ?v= the layout adds changes on every upload, so
// browsers may cache this for a while.

import { NextResponse } from "next/server";
import { getPlatformSettings } from "@/lib/platform/settings";
import { isR2Configured, signGetUrl } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { branding } = await getPlatformSettings();
  if (!branding.logoKey || !isR2Configured()) {
    return NextResponse.json({ error: "no_logo" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const url = await signGetUrl(branding.logoKey, 3600);
  return NextResponse.redirect(url, { status: 302, headers: { "cache-control": "public, max-age=600" } });
}

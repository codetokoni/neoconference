// src/app/api/app/latest/route.ts
//
// GET /api/app/latest — the Android app's newest version on the LoveWorld
// AppStore, the oldest still allowed to join, and where to update. Public:
// the app reads it at start (1.2.5 and later) to offer the update.

import { NextResponse } from "next/server";
import { APP_STORE_URL } from "@/lib/appGate";
import { LATEST_APP_VERSION, UPDATE_URL, clerkFrontendApi, minAppVersion } from "@/lib/appRelease";
import { BRAND } from "@/lib/brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    // updateUrl: where the app sends people to update — the store, through
    // the short link, so every download is counted on the LoveWorld AppStore.
    // site, clerkFrontendApi: where the website and Clerk's sign-in are now.
    // The app (from 1.2.6) follows them, so the move to neolinguameet.com
    // — and Clerk's domain with it — needs no further app release.
    {
      latestVersion: LATEST_APP_VERSION,
      minVersion: minAppVersion(),
      storeUrl: APP_STORE_URL,
      updateUrl: UPDATE_URL,
      site: BRAND.origin,
      ...(clerkFrontendApi() ? { clerkFrontendApi: clerkFrontendApi() } : {}),
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

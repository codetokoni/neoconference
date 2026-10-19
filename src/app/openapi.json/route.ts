// GET /openapi.json — the public API's OpenAPI description, read by /docs.
//
// The spec lives in src/lib/openapi.base.json; its product name and server
// address follow the brand (src/lib/brand.ts), so API users see the current
// name and call the current domain.

import { NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";
import base from "@/lib/openapi.base.json";

export const dynamic = "force-static";

export function GET() {
  const text = JSON.stringify(base)
    .replaceAll("https://www.neoconference.app", BRAND.origin)
    .replaceAll("neoconference.app", BRAND.domain)
    .replaceAll("NeoConference", BRAND.name);
  return new NextResponse(text, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

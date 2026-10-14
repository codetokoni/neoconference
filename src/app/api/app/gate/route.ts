// src/app/api/app/gate/route.ts
//
// GET /api/app/gate?slug=<meeting> — whether an Android phone opening this
// meeting's link should stay in the browser ({ browser: true }) instead of
// being shown "Get the NeoConference app" (components/AndroidAppGate.tsx).
// The owner sets it per meeting ("Phones open it in the browser"). Public:
// the screen asks before a visitor signs in, and it says nothing more than
// the link itself already does.

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const slug = (new URL(req.url).searchParams.get("slug") || "").trim().toLowerCase().slice(0, 64);
  let browser = false;
  if (slug) {
    try {
      const ev = await eventStore.bySlug(slug);
      browser = Boolean(ev?.browserOnPhones);
    } catch {
      // Unknown or unreadable: the usual app screen.
    }
  }
  return NextResponse.json({ browser }, { headers: { "cache-control": "public, max-age=30" } });
}

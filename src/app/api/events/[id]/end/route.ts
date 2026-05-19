// src/app/api/events/[id]/end/route.ts
// Owner-only POST. Marks an event as ended, then fires a best-effort
// background AI-summary generation so the host gets a recap automatically.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { assertOwnerOrAdmin } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const check = await assertOwnerOrAdmin(ev, userId);
  if (!check.ok) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const next = await eventStore.update(ev.id, (prev) => ({
    ...prev,
    state: "ended",
    endedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  // Fire-and-forget: ask the summary endpoint to generate a recap.
  // We intentionally do not await this so the response stays fast.
  try {
    const proto = req.headers.get("x-forwarded-proto") || "https";
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (host) {
      const url = `${proto}://${host}/api/events/${ev.id}/summary`;
      const cookie = req.headers.get("cookie") || "";
      // No await on purpose.
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ trigger: "event-end" }),
      }).catch(() => {});
      // Also kick off chapter derivation (best-effort)
      const chaptersUrl = `${proto}://${host}/api/events/${ev.id}/chapters`;
      fetch(chaptersUrl, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
      }).catch(() => {});
    }
  } catch {
    // Ignore: summary is best-effort.
  }

  return NextResponse.json({ ok: true, event: next });
}



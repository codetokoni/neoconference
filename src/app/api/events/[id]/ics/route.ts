// src/app/api/events/[id]/ics/route.ts
// Public GET. Returns an RFC 5545 calendar invite (.ics) for an event.
// Resolves by id OR by slug so it can be linked from public event pages.

import { type NextRequest } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { buildIcs } from "@/lib/ics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let ev = await eventStore.byId(id);
  if (!ev) ev = await eventStore.bySlug(id);
  if (!ev) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "neoconference.vercel.app";
  const eventUrl = `${proto}://${host}/e/${ev.slug}`;

  const body = buildIcs(ev, {
    eventUrl,
    host,
    durationMin: ev.groupMeeting?.durationMin,
    sequence: ev.groupMeeting?.sequence,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${ev.slug}.ics"`,
      "cache-control": "public, max-age=60",
    },
  });
}

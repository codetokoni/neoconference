// src/app/api/events/[id]/ics/route.ts
// Public GET. Returns an RFC 5545 calendar invite (.ics) for an event.
// Resolves by id OR by slug so it can be linked from public event pages.

import { type NextRequest } from "next/server";
import { eventStore } from "@/lib/eventStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pad(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

function fmtUtc(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  return (""
    + d.getUTCFullYear()
    + pad(d.getUTCMonth() + 1)
    + pad(d.getUTCDate())
    + "T"
    + pad(d.getUTCHours())
    + pad(d.getUTCMinutes())
    + pad(d.getUTCSeconds())
    + "Z");
}

function escapeIcs(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    parts.push((i === 0 ? "" : " ") + line.slice(i, i + (i === 0 ? 75 : 74)));
    i += i === 0 ? 75 : 74;
  }
  return parts.join("\r\n");
}

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

  const startIso = ev.scheduledAt || ev.createdAt;
  const dtStart = fmtUtc(startIso);
  const startMs = new Date(startIso).getTime();
  const endMs = startMs + 60 * 60 * 1000;
  const dtEnd = fmtUtc(new Date(endMs).toISOString());
  const dtStamp = fmtUtc(new Date().toISOString());
  const uid = `neo-${ev.id}@${host}`;

  const summary = escapeIcs(ev.name || ev.slug || "NeoConference event");
  const description = escapeIcs(
    [ev.description || "", "", "Join: " + eventUrl].filter(Boolean).join("\n")
  );
  const location = escapeIcs(eventUrl);

  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NeoConference//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    fold(`SUMMARY:${summary}`),
    fold(`DESCRIPTION:${description}`),
    fold(`LOCATION:${location}`),
    fold(`URL:${eventUrl}`),
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n") + "\r\n";

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${ev.slug}.ics"`,
      "cache-control": "public, max-age=60",
    },
  });
}


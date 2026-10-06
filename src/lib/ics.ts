// src/lib/ics.ts
//
// RFC 5545 calendar files for an event. Used by GET /api/events/[id]/ics and
// by the invitation emails group meetings send (src/lib/groupNotify.ts).

import type { NeoEvent } from "@/types/event";

function pad(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

export function fmtUtc(iso?: string | null): string {
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

export function escapeIcs(s: string): string {
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

export interface IcsOptions {
  /** The link the invite opens. */
  eventUrl: string;
  /** Host name for the UID, so the same event keeps the same UID everywhere. */
  host: string;
  /**
   * PUBLISH for a plain download, REQUEST for an emailed invitation (which
   * calendars add and later update), CANCEL to take it off their calendar.
   */
  method?: "PUBLISH" | "REQUEST" | "CANCEL";
  /** Raised on every change; a calendar keeps the highest it has seen. */
  sequence?: number;
  /** Minutes; one hour when not given. */
  durationMin?: number;
  /** Organizer shown by calendars; omitted when not given. */
  organizer?: { name: string; email: string };
}

type IcsEvent = Pick<NeoEvent, "id" | "slug" | "name" | "description" | "scheduledAt" | "createdAt">;

/** The .ics text for one event. */
export function buildIcs(ev: IcsEvent, opts: IcsOptions): string {
  return buildIcsCalendar([{ ev, opts }], opts.method ?? "PUBLISH");
}

/**
 * One calendar file holding several events — every occurrence of a series
 * changed at once arrives as one attachment rather than one email each.
 */
export function buildIcsCalendar(
  items: Array<{ ev: IcsEvent; opts: IcsOptions }>,
  method: "PUBLISH" | "REQUEST" | "CANCEL"
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NeoConference//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    ...items.flatMap(({ ev, opts }) => vevent(ev, { ...opts, method })),
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

function vevent(ev: IcsEvent, opts: IcsOptions): string[] {
  const method = opts.method ?? "PUBLISH";
  const startIso = ev.scheduledAt || ev.createdAt;
  const startMs = new Date(startIso).getTime();
  const endMs = startMs + (opts.durationMin ?? 60) * 60 * 1000;
  const summary = escapeIcs(ev.name || ev.slug || "NeoConference event");
  const description = escapeIcs(
    [ev.description || "", "", "Join: " + opts.eventUrl].filter(Boolean).join("\n")
  );
  const location = escapeIcs(opts.eventUrl);

  return [
    "BEGIN:VEVENT",
    `UID:neo-${ev.id}@${opts.host}`,
    `DTSTAMP:${fmtUtc(new Date().toISOString())}`,
    `DTSTART:${fmtUtc(startIso)}`,
    `DTEND:${fmtUtc(new Date(endMs).toISOString())}`,
    `SEQUENCE:${opts.sequence ?? 0}`,
    fold(`SUMMARY:${summary}`),
    fold(`DESCRIPTION:${description}`),
    fold(`LOCATION:${location}`),
    fold(`URL:${opts.eventUrl}`),
    ...(opts.organizer
      ? [fold(`ORGANIZER;CN=${escapeIcs(opts.organizer.name)}:mailto:${opts.organizer.email}`)]
      : []),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
  ];
}

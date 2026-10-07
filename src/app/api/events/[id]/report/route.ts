// src/app/api/events/[id]/report/route.ts
//
// GET — a meeting's report, for History: when it ran and for how long, who
// came (each person's join and leave times, minutes and rejoins), who was
// invited but never came, chat messages, and the recording. Any meeting, in a
// group or not; a group meeting's report is the one its group sees.
//
// Path param: id or slug (byId ?? bySlug fallthrough, as the attendance export).
// Authorization: transcript:read (RANK.host) — the same gate as the attendance
// spreadsheet and the attendees list, which this is a fuller view of.
//
// `spreadsheetUrl` is that spreadsheet (/api/events/<id>/attendance).

import { NextResponse, type NextRequest } from "next/server";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import { hasAttendance } from "@/lib/groupAttendees";
import { getMeetingReport } from "@/lib/groupReports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const event = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!event) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const gate = await authorize(event, "transcript:read");
  if (!gate.ok) return gate.response;

  if (!hasAttendance(event)) {
    return NextResponse.json({ error: "not_started" }, { status: 409 });
  }

  const report = await getMeetingReport(event.id);
  if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json(
    {
      report: {
        ...report,
        // The spreadsheet row duplicates the fields beside it; leave it out.
        participants: report.participants.map(({ row: _row, ...p }) => p),
      },
      spreadsheetUrl: `/api/events/${encodeURIComponent(event.id)}/attendance`,
    },
    { headers: { "cache-control": "no-store" } }
  );
}

// GET /api/attendance-groups/<token> — a session's attendance by church or
// group as a spreadsheet (src/lib/attendanceGroups.ts). The token is the
// link sent to the meeting's owner (every group) or to one group's leader
// (theirs only, without email addresses); it lasts 30 days and is the only
// key, so leaders without an account here can open it.

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { fileName, readDownload, sessionByGroup, sessionWorkbook } from "@/lib/attendanceGroups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const d = await readDownload(token);
  if (!d) return NextResponse.json({ error: "not_found", message: "This link has expired or is not valid." }, { status: 404 });
  const ev = await eventStore.byId(d.eventId);
  if (!ev) return NextResponse.json({ error: "not_found", message: "This meeting no longer exists." }, { status: 404 });
  const s = await sessionByGroup(ev, d.start, d.end);
  const file = await sessionWorkbook(s, d.group ?? undefined);
  return new NextResponse(new Uint8Array(file), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName(ev.name, d.start, d.group))}`,
      "cache-control": "private, no-store",
    },
  });
}

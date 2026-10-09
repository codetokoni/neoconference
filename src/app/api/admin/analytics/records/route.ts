// GET /api/admin/analytics/records — the records behind a store-backed figure
// on /admin/analytics (analytics:read): the meetings created or ended, or the
// accounts created. Meeting titles only for administrators who also hold
// events:read.
//
// Query: metric=meetings|meetingMinutes|signUps, from, to, tz, format=csv|xlsx
// (also needs reports:export).

import { NextResponse } from "next/server";
import { can, requireAdmin } from "@/lib/admin/context";
import { accountHref, clerkSignUps, meetingRecords } from "@/lib/admin/analytics";
import { periodFromQuery } from "@/lib/activityReports";
import { csvResponse, xlsxResponse, zonedStamp, type Table } from "@/lib/admin/exportReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  const exporting = format === "csv" || format === "xlsx";
  const g = await requireAdmin(req, exporting ? ["analytics:read", "reports:export"] : "analytics:read");
  if (!g.ok) return g.response;
  const p = periodFromQuery(url.searchParams, 30);
  if (url.searchParams.get("metric") === "signUps") {
    const users = await clerkSignUps(p.startMs, p.endMs);
    if (!users) return NextResponse.json({ error: "clerk_unavailable", message: "Could not read accounts from Clerk." }, { status: 502 });
    const items = users.map((u) => ({ ...u, href: accountHref(u.id) }));
    if (!exporting) return NextResponse.json({ ok: true, metric: "signUps", period: { from: p.from, to: p.to, tz: p.tz }, items });
    const table: Table = {
      name: "Sign-ups",
      columns: [
        { header: "Name", key: "label", width: 26 },
        { header: "Email", key: "email", width: 30 },
        { header: "User id", key: "id", width: 34 },
        { header: `Signed up (${p.tz})`, key: "created", width: 20 },
      ],
      rows: items.map((u) => ({ ...u, created: zonedStamp(u.createdAt, p.tz) })),
    };
    const base = `neoconference-sign-ups-${p.from}-to-${p.to}`;
    return format === "xlsx" ? xlsxResponse([table], base) : csvResponse(table, base);
  }
  const metric = url.searchParams.get("metric") === "meetingMinutes" ? "meetingMinutes" : "meetings";
  const withTitles = can(g.ctx, "events:read");
  const items = await meetingRecords(p, metric, withTitles);
  if (!exporting) return NextResponse.json({ ok: true, metric, withTitles, period: { from: p.from, to: p.to, tz: p.tz }, items });

  const table: Table = {
    name: metric === "meetings" ? "Meetings created" : "Meeting minutes",
    columns: [
      { header: "Meeting id", key: "id", width: 24 },
      { header: "Link", key: "slug", width: 20 },
      ...(withTitles ? [{ header: "Title", key: "title", width: 30 }] : []),
      { header: "Owner", key: "owner", width: 24 },
      { header: "Owner id", key: "ownerId", width: 32 },
      { header: "Plan", key: "plan" },
      { header: `Created (${p.tz})`, key: "created", width: 20 },
      { header: `Started (${p.tz})`, key: "started", width: 20 },
      { header: `Ended (${p.tz})`, key: "ended", width: 20 },
      { header: "Minutes", key: "minutes" },
      { header: "State", key: "state" },
    ],
    rows: items.map((i) => ({
      ...i,
      created: zonedStamp(i.createdAt, p.tz),
      started: zonedStamp(i.startedAt, p.tz),
      ended: zonedStamp(i.endedAt, p.tz),
    })),
  };
  const base = `neoconference-${metric}-${p.from}-to-${p.to}`;
  return format === "xlsx" ? xlsxResponse([table], base) : csvResponse(table, base);
}

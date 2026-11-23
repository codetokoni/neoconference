// /api/me/full-name — the signed-in person's "Full name for attendance"
// (src/lib/attendeeName.ts, src/lib/attendanceName.ts). The web join screen
// and the app's join step use it.
//
// GET   { fullName, saved }   what the field starts with: the name they last
//                             confirmed (saved: true); on first use KingsChat's
//                             full name or the account's own first and last
//                             name; otherwise "". Never a username or email.
// POST  { fullName }          confirms it before joining: checked, saved on
//                             the account, and remembered for the join that
//                             follows, which records it on the attendance entry.
//
// With ?event=<slug> (GET) or { event, group } (POST), for a meeting that
// lists churches or groups (src/lib/attendanceGroups.ts): GET adds
// { groups, group } (the list and their pick), POST keeps their pick, which
// must be one of the list.
//
// Only ever the caller's own account. The name is kept private to them: it is
// not in their public profile, their meeting tile or the people list.

import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { attendanceNamePrefill, savedAttendanceName } from "@/lib/attendeeName";
import { confirmAttendanceName } from "@/lib/attendanceName";
import { choiceOf, groupNames, matchGroup, setChoice } from "@/lib/attendanceGroups";
import { eventStore } from "@/lib/eventStore";

/** The meeting a slug names, when it lists groups. */
async function meetingWithGroups(slug: unknown) {
  if (typeof slug !== "string" || !slug || slug.length > 120) return null;
  const ev = await eventStore.bySlug(slug).catch(() => null);
  return ev && groupNames(ev).length ? ev : null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req?: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cc = await clerkClient();
  const user = await cc.users.getUser(userId);
  const ev = await meetingWithGroups(req ? new URL(req.url).searchParams.get("event") : null);
  const groups = ev ? { groups: groupNames(ev), group: await choiceOf(ev.id, userId) } : {};
  return NextResponse.json(
    { fullName: attendanceNamePrefill(user), saved: Boolean(savedAttendanceName(user)), ...groups },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { fullName?: unknown; event?: unknown; group?: unknown } | null;
  // A church or group must be one of the meeting's, checked before anything is saved.
  const ev = await meetingWithGroups(body?.event);
  const group = ev && body?.group !== undefined ? matchGroup(ev, body.group) : "";
  if (ev && body?.group !== undefined && !group) {
    return NextResponse.json({ error: "invalid_group", message: "Choose your church or group from the list." }, { status: 400 });
  }
  const cc = await clerkClient();
  const user = await cc.users.getUser(userId);
  const r = await confirmAttendanceName(user, body?.fullName);
  if (!r.ok) {
    return NextResponse.json({ error: r.status === 400 ? "invalid_name" : "save_failed", message: r.message }, { status: r.status });
  }
  if (ev && group) await setChoice(ev.id, userId, group);
  return NextResponse.json({ ok: true, fullName: r.name, saved: true, ...(group ? { group } : {}) });
}

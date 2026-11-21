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
// Only ever the caller's own account. The name is kept private to them: it is
// not in their public profile, their meeting tile or the people list.

import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { attendanceNamePrefill, savedAttendanceName } from "@/lib/attendeeName";
import { confirmAttendanceName } from "@/lib/attendanceName";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cc = await clerkClient();
  const user = await cc.users.getUser(userId);
  return NextResponse.json(
    { fullName: attendanceNamePrefill(user), saved: Boolean(savedAttendanceName(user)) },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { fullName?: unknown } | null;
  const cc = await clerkClient();
  const user = await cc.users.getUser(userId);
  const r = await confirmAttendanceName(user, body?.fullName);
  if (!r.ok) {
    return NextResponse.json({ error: r.status === 400 ? "invalid_name" : "save_failed", message: r.message }, { status: r.status });
  }
  return NextResponse.json({ ok: true, fullName: r.name, saved: true });
}

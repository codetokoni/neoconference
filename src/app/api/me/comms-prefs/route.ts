// /api/me/comms-prefs — the signed-in person's notification preferences.
//
// GET   { categories, prefs }  the optional categories and their choices
// PUT   { announcements?: { email?, inApp?, push? }, product?: …, reminders?: … }
//
// Transactional and security email (meeting invitations, sign-in notices,
// receipts) and service notices are not categories here, so they cannot be
// turned off.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getPrefs, PREF_CATEGORIES, updatePrefs } from "@/lib/comms/prefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ categories: PREF_CATEGORIES, prefs: await getPrefs(userId) }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { after } = await updatePrefs(userId, body, "settings");
  return NextResponse.json({ ok: true, prefs: after });
}

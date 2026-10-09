// POST /api/admin/mfa/lock — end the admin session now (the Clerk sign-in
// stays). The next visit asks for a code again.

import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin/mfa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

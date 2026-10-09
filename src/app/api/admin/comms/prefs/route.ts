// /api/admin/comms/prefs — one person's notification preferences (users:read).
//
// GET ?user=<user id or email>   read-only: what they turned off and when.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/admin/context";
import { fail } from "@/lib/admin/http";
import { getPrefs } from "@/lib/comms/prefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "users:read");
  if (!g.ok) return g.response;
  const who = (new URL(req.url).searchParams.get("user") ?? "").trim();
  if (!who) return fail("user_required", "Enter a user id or email.");
  const client = await clerkClient();
  let user: { id: string; firstName?: string | null; lastName?: string | null; emailAddresses?: { emailAddress: string }[] } | null = null;
  try {
    if (who.includes("@")) {
      const list = await client.users.getUserList({ emailAddress: [who.toLowerCase()], limit: 1 });
      user = list.data[0] ?? null;
    } else {
      user = await client.users.getUser(who);
    }
  } catch {
    user = null;
  }
  if (!user) return fail("not_found", "No account matches that.", 404);
  return NextResponse.json({
    user: {
      id: user.id,
      name: [user.firstName, user.lastName].filter(Boolean).join(" "),
      email: user.emailAddresses?.[0]?.emailAddress ?? "",
    },
    prefs: await getPrefs(user.id),
  });
}

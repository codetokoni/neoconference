// GET /api/admin/subscriptions/lookup?q=… (plans:read) — find an account by
// email, name or id to open its subscription. Owner accounts are listed but
// marked, since nothing can be done to them here.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAdmin } from "@/lib/admin/context";
import { isOwnerEmailList, type ClerkEmailish } from "@/lib/admin/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "plans:read");
  if (!g.ok) return g.response;
  const q = (new URL(req.url).searchParams.get("q") || "").trim().slice(0, 100);
  if (q.length < 2) return NextResponse.json({ ok: true, users: [] });
  const client = await clerkClient();
  const found = q.startsWith("user_")
    ? await client.users
        .getUser(q)
        .then((u) => [u])
        .catch(() => [])
    : ((await client.users.getUserList({ query: q, limit: 10 })) as { data: unknown[] }).data;
  const users = (found as { id: string; firstName?: string | null; lastName?: string | null; emailAddresses?: ClerkEmailish[]; publicMetadata?: Record<string, unknown> }[]).map((u) => ({
    userId: u.id,
    email: u.emailAddresses?.[0]?.emailAddress ?? "",
    name: [u.firstName, u.lastName].filter(Boolean).join(" "),
    plan: (u.publicMetadata?.plan as string | undefined) ?? "free",
    isOwner: isOwnerEmailList(u.emailAddresses),
  }));
  return NextResponse.json({ ok: true, users });
}

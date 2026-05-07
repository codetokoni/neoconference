// src/app/api/events/role/route.ts
// Lightweight GET that returns the caller’s effective role for an event.
// Used by the in-room SpeakerBadge.
// Query: ?slug=<event slug>
// Response: { role: "host" | "cohost" | "speaker" | "viewer" | "guest", preApproved: boolean, isOwner: boolean }

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  const ev = await eventStore.bySlug(slug);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ role: "guest", preApproved: false, isOwner: false });
  }

  const isOwner = ev.ownerUserId === userId;
  if (isOwner) {
    return NextResponse.json({ role: "host", preApproved: true, isOwner: true });
  }

  // Match role assignment: by Clerk user id, primary email, or any verified email.
  const u = await currentUser().catch(() => null);
  const emails = (u?.emailAddresses || []).map((e: { emailAddress: string }) => e.emailAddress.toLowerCase());
  const roles = ev.role
s || [];
  const match = roles.find((r) => {
    const id = r.identifier.toLowerCase();
    return id === userId.toLowerCase() || emails.includes(id);
  });
  if (!match) {
    return NextResponse.json({ role: "viewer", preApproved: false, isOwner: false });
  }
  return NextResponse.json({
    role: match.role,
    preApproved: Boolean(match.preApproved),
    isOwner: false,
  });
}

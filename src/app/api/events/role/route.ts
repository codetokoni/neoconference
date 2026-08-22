// src/app/api/events/role/route.ts
// Lightweight GET that returns the caller's effective role for an event.
// Used by the in-room SpeakerBadge and the recording / waiting-room / breakouts gating.
// Query: ?slug=<event slug>
// Response: { role: "host" | "cohost" | "speaker" | "viewer" | "guest", preApproved: boolean, isOwner: boolean, ownerUserId: string | null }

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eventStore, adoptOrphanRoom } from "@/lib/eventStore";
import { isAdmin } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  let ev = await eventStore.bySlug(slug);

  // Pre-fetch user info up front — we may need it for orphan adoption too.
  const { userId } = await auth();
  let u: Awaited<ReturnType<typeof currentUser>> | null = null;
  if (userId) {
    u = await currentUser().catch(() => null);
  }
  const userEmails = (u?.emailAddresses || []).map((e: { emailAddress: string }) => e.emailAddress.toLowerCase());
  const primaryEmail = (u?.emailAddresses?.find((e: { id: string; emailAddress: string }) => e.id === u?.primaryEmailAddressId)?.emailAddress || u?.emailAddresses?.[0]?.emailAddress || '').toLowerCase();

  // Orphan-room handling: if no event record exists but we have an authenticated
  // user, adopt the room with that user as host. This makes shared/legacy URLs
  // actually usable for host-gated features (recording, waiting room, etc.).
  if (!ev) {
    if (!userId) {
      // Unauthenticated callers don't get to adopt rooms.
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    ev = await adoptOrphanRoom(slug, userId, primaryEmail || undefined);
    if (!ev) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
  }

  if (!userId) {
    return NextResponse.json({ role: "guest", preApproved: false, isOwner: false, ownerUserId: ev.ownerUserId || null, isLocked: Boolean(ev.isLocked), endPinRequired: Boolean(ev.endPin), inactivity: ev.inactivity ?? null });
  }

  // Permanent admins (ADMIN_EMAILS env var) are treated as host of any room
  // they join. Keep isOwner=false — they are *acting as* host, not the actual
  // owner of the event record.
  if (userEmails.some((e) => isAdmin(e))) {
    return NextResponse.json({ role: "host", preApproved: true, isOwner: false, ownerUserId: ev.ownerUserId || null, isLocked: Boolean(ev.isLocked), endPinRequired: Boolean(ev.endPin), inactivity: ev.inactivity ?? null });
  }

  const ownerEmail = (ev.ownerEmail || "").toLowerCase();
  const isOwner = ev.ownerUserId === userId
    || (ownerEmail !== "" && userEmails.includes(ownerEmail));
  if (isOwner) {
    return NextResponse.json({ role: "host", preApproved: true, isOwner: true, ownerUserId: ev.ownerUserId || null, isLocked: Boolean(ev.isLocked), endPinRequired: Boolean(ev.endPin), inactivity: ev.inactivity ?? null });
  }

  // Match role assignment: by Clerk user id, primary email, or any verified email.
  const emails = userEmails;
  const roles = ev.roles || [];
  const match = roles.find((r) => {
    const id = r.identifier.toLowerCase();
    return id === userId.toLowerCase() || emails.includes(id);
  });
  if (!match) {
    return NextResponse.json({ role: "viewer", preApproved: false, isOwner: false, ownerUserId: ev.ownerUserId || null, isLocked: Boolean(ev.isLocked), endPinRequired: Boolean(ev.endPin), inactivity: ev.inactivity ?? null });
  }
  return NextResponse.json({
    role: match.role,
    preApproved: Boolean(match.preApproved),
    isOwner: false,
    ownerUserId: ev.ownerUserId || null,
    isLocked: Boolean(ev.isLocked),
    endPinRequired: Boolean(ev.endPin),
    inactivity: ev.inactivity ?? null,
  });
}

// src/app/api/events/role/route.ts
// Lightweight GET that returns the caller's effective role for an event.
// Used by the in-room SpeakerBadge and the recording / waiting-room / breakouts gating.
// Query: ?slug=<event slug>
// Response: { role: "host" | "cohost" | "speaker" | "viewer" | "guest", preApproved: boolean, isOwner: boolean, ownerUserId: string | null }

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eventStore, generateId, generateQrSeed } from "@/lib/eventStore";
import type { NeoEvent } from "@/types/event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Adopt an "orphan" room (one with no backing event record) by creating a
// minimal event record with the first authenticated caller as host/owner.
// This handles three cases:
//   1. A user lands on /room/<slug> via a stale or shared link where no event
//      was ever provisioned (the original instant-meeting endpoint creates one;
//      direct URLs don't).
//   2. KV is cold or eventually-consistent and the event hasn't propagated yet
//      — in that race we'd rather elect the current user as host than leave
//      the room with no host at all (which blocks recording approval, waiting
//      room admission, etc.).
//   3. Old test rooms created before this endpoint was deployed.
async function adoptOrphanRoom(slug: string, userId: string, email?: string): Promise<NeoEvent | null> {
  const now = new Date().toISOString();
  const ev: NeoEvent = {
    id: generateId(),
    slug,
    name: slug,
    ownerUserId: userId,
    ownerEmail: email,
    visibility: 'unlisted',
    waitingRoomEnabled: false,
    livekitRoom: slug,
    hsmoh: { shortCode: slug, shortUrl: '/e/' + slug, fallback: true },
    qrSeed: generateQrSeed(),
    roles: [],
    waitingRoom: [],
    recordings: [],
    state: 'live',
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await eventStore.create(ev);
    return ev;
  } catch (e) {
    // Race: another request may have just created it. Re-read and use whatever
    // exists rather than failing the role check.
    console.warn('[events/role] adoptOrphanRoom create failed, re-reading', e);
    return await eventStore.bySlug(slug);
  }
}

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
    return NextResponse.json({ role: "guest", preApproved: false, isOwner: false, ownerUserId: ev.ownerUserId || null });
  }

  const ownerEmail = (ev.ownerEmail || "").toLowerCase();
  const isOwner = ev.ownerUserId === userId
    || (ownerEmail !== "" && userEmails.includes(ownerEmail));
  if (isOwner) {
    return NextResponse.json({ role: "host", preApproved: true, isOwner: true, ownerUserId: ev.ownerUserId || null });
  }

  // Match role assignment: by Clerk user id, primary email, or any verified email.
  const emails = userEmails;
  const roles = ev.roles || [];
  const match = roles.find((r) => {
    const id = r.identifier.toLowerCase();
    return id === userId.toLowerCase() || emails.includes(id);
  });
  if (!match) {
    return NextResponse.json({ role: "viewer", preApproved: false, isOwner: false, ownerUserId: ev.ownerUserId || null });
  }
  return NextResponse.json({
    role: match.role,
    preApproved: Boolean(match.preApproved),
    isOwner: false,
    ownerUserId: ev.ownerUserId || null,
  });
}

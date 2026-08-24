// src/app/api/events/hide-video/route.ts
//
// FRS §5.x display-only moderation: hide a participant's video from all
// viewers without stopping their camera. The moderator keeps the
// authority to reveal at any time.
//
// GET   ?slug=<event slug>
//       Returns { hidden: string[] }
//       Public read (any authenticated caller). Used by clients on room
//       mount so late joiners get the current suppression state and by
//       clients that missed the data-channel broadcast.
//
// POST  body: { slug, identity, hide: boolean }
//       Requires participant:hideVideo (moderator+). Updates the Redis
//       hash and returns the fresh list. The caller then broadcasts a
//       {type:"hidden-videos", set} data-channel message so every open
//       client updates without polling; this route deliberately does not
//       push a LiveKit data packet of its own — the RoomServiceClient
//       broadcast on every mutation would double the failure surface for
//       what is a low-frequency, best-effort UX signal.
//
// Neither route ever changes track state; the participant's camera stays
// on regardless. If a moderator wants to force the camera off, they use
// the existing `muteVideo` moderation action instead.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import { getHiddenVideos, hideVideo, showVideo } from "@/lib/hiddenVideos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  slug?: unknown;
  identity?: unknown;
  hide?: unknown;
}

const bad = (code: string, status = 400) =>
  NextResponse.json({ error: code }, { status });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug) return bad("missing_slug");

  const { userId } = await auth();
  if (!userId) return bad("unauthorized", 401);

  const event = await eventStore.bySlug(slug);
  if (!event) return NextResponse.json({ hidden: [] });

  const hidden = await getHiddenVideos(event.id);
  return NextResponse.json({ hidden });
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return bad("invalid_json");
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const identity = typeof body.identity === "string" ? body.identity.trim() : "";
  const hide = body.hide === true;
  if (!slug) return bad("missing_slug");
  if (!identity) return bad("missing_identity");

  const event = await eventStore.bySlug(slug);
  if (!event) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const gate = await authorize(event, "participant:hideVideo");
  if (!gate.ok) return gate.response;

  if (hide) {
    await hideVideo(event.id, identity);
  } else {
    await showVideo(event.id, identity);
  }

  const hidden = await getHiddenVideos(event.id);
  return NextResponse.json({ ok: true, hidden });
}

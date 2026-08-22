// src/app/api/golive/destination/route.ts
//
// POST — add a livestream destination to an active broadcast.
//
// FRS §2: "Select the livestream destination." The GoLive create route
// already provisions a StreamLab stream and returns RTMP ingest credentials;
// this second route lets the host fan the same stream out to additional
// platforms (YouTube Live, Facebook Live, Twitch, or a generic RTMP endpoint).
//
// Body: {
//   eventSlug: string,
//   destination: {
//     platform: "youtube" | "facebook" | "twitch" | "rtmp",
//     rtmp_url?: string,
//     stream_key?: string,
//     label?: string
//   }
// }
//
// Authorization: stream:golive (RANK.host) — same permission as the
// original /api/golive.

import { NextResponse } from "next/server";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import { streamlab, type StreamLabDestination } from "@/lib/streamlab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLATFORMS = new Set<StreamLabDestination["platform"]>([
  "youtube",
  "facebook",
  "twitch",
  "rtmp",
]);

interface Body {
  eventSlug?: unknown;
  destination?: unknown;
}

export async function POST(req: Request) {
  if (!streamlab.isConfigured()) {
    return NextResponse.json(
      { ok: false, error: "streamlab_not_configured" },
      { status: 503 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const slug = typeof body.eventSlug === "string" ? body.eventSlug.trim() : "";
  if (!slug) {
    return NextResponse.json({ ok: false, error: "missing_event_slug" }, { status: 400 });
  }
  const raw = body.destination as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ ok: false, error: "missing_destination" }, { status: 400 });
  }
  const platform = typeof raw.platform === "string" ? raw.platform : "";
  if (!PLATFORMS.has(platform as StreamLabDestination["platform"])) {
    return NextResponse.json({ ok: false, error: "invalid_platform" }, { status: 400 });
  }
  const rtmp_url = typeof raw.rtmp_url === "string" ? raw.rtmp_url.trim() : undefined;
  const stream_key = typeof raw.stream_key === "string" ? raw.stream_key.trim() : undefined;
  const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 80) : undefined;

  // For the generic 'rtmp' platform, both fields are required — the plaform-
  // specific ones can rely on the StreamLab side to handle discovery/oauth.
  if (platform === "rtmp" && (!rtmp_url || !stream_key)) {
    return NextResponse.json(
      { ok: false, error: "rtmp_url_and_stream_key_required" },
      { status: 400 },
    );
  }

  const event = await eventStore.bySlug(slug);
  if (!event) {
    return NextResponse.json({ ok: false, error: "event_not_found" }, { status: 404 });
  }
  const gate = await authorize(event, "stream:golive");
  if (!gate.ok) return gate.response;

  const streamId = event.streamlab?.streamId;
  if (!streamId) {
    return NextResponse.json(
      { ok: false, error: "no_active_broadcast", message: "Start a broadcast first via /api/golive." },
      { status: 400 },
    );
  }

  try {
    const result = await streamlab.addDestination({
      stream_id: streamId,
      destination: {
        platform: platform as StreamLabDestination["platform"],
        rtmp_url,
        stream_key,
        label,
      },
    });
    return NextResponse.json({ ok: true, destination: result.destination });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}

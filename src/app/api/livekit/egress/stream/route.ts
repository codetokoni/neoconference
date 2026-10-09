// src/app/api/livekit/egress/stream/route.ts
//
// Livestream the meeting itself — its composed video and audio, as a
// recording is made — to YouTube, Facebook, Twitch or an RTMP address.
//
//   POST   { room, destinations: [{ platform, key, label? }] }  start
//   GET    ?room=<slug>                                         status
//   DELETE { room }                                             stop
//
// Host rank ('stream:golive'), and the meeting owner's plan must include
// livestreaming (Enterprise); operators are exempt, as from every plan
// limit. Stream keys are sent to LiveKit and kept nowhere: the event holds
// the platforms and names, and status is read back from LiveKit by
// position, never as the URL.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { EgressClient, StreamOutput, StreamProtocol } from "livekit-server-sdk";
import { eventStore } from "@/lib/eventStore";
import { authorize } from "@/lib/authz";
import { errorMessage } from "@/lib/errorMessage";
import { getPlanLimitsForUserId, isAdminUserId } from "@/lib/plan";
import {
  destinationProblem,
  destinationStatus,
  publicDestination,
  rtmpUrlFor,
  type LiveStreamState,
  type StreamDestinationInput,
  type StreamPlatform,
} from "@/lib/livestream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** At most this many destinations per stream: LiveKit fans out to each. */
const MAX_DESTINATIONS = 4;

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function egressClient(): EgressClient {
  const wsUrl = requiredEnv("NEXT_PUBLIC_LIVEKIT_URL");
  return new EgressClient(wsUrl.replace(/^ws/, "http"), requiredEnv("LIVEKIT_API_KEY"), requiredEnv("LIVEKIT_API_SECRET"));
}

async function eventFor(room: string) {
  return (await eventStore.bySlug(room)) ?? null;
}

/** The stream's state with each destination's status, for the room UI. */
async function statusOf(ev: { livestream?: LiveStreamState }) {
  const live = ev.livestream;
  if (!live) return { live: false as const };
  let infos: Array<{ status: number; error: string }> = [];
  let egressStatus: number | null = null;
  let egressError: string | undefined;
  try {
    const found = await egressClient().listEgress({ egressId: live.egressId });
    const info = found[0];
    if (info) {
      egressStatus = info.status as number;
      egressError = info.error || undefined;
      infos = info.streamResults.map((s) => ({ status: s.status as number, error: s.error }));
    }
  } catch (e) {
    console.warn("[egress/stream] status lookup failed", errorMessage(e));
  }
  return {
    live: true as const,
    egressId: live.egressId,
    startedAt: live.startedAt,
    startedBy: live.startedBy,
    // EgressStatus: STARTING 0, ACTIVE 1, ENDING 2, COMPLETE 3, FAILED 4, ABORTED 5.
    egress: egressStatus === null ? "unknown" : egressStatus === 1 ? "active" : egressStatus === 0 ? "starting" : "ended",
    error: egressError,
    destinations: live.destinations.map((d, i) => ({ ...d, ...destinationStatus(infos[i]) })),
  };
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  const room = (new URL(req.url).searchParams.get("room") || "").trim();
  if (!room) return NextResponse.json({ ok: false, error: "missing_room" }, { status: 400 });
  const ev = await eventFor(room);
  if (!ev) return NextResponse.json({ ok: false, error: "event_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...(await statusOf(ev)) });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });

  let body: { room?: unknown; destinations?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const room = typeof body.room === "string" ? body.room.trim() : "";
  if (!room) return NextResponse.json({ ok: false, error: "missing_room" }, { status: 400 });

  const ev = await eventFor(room);
  if (!ev) return NextResponse.json({ ok: false, error: "event_not_found" }, { status: 404 });
  const gate = await authorize(ev, "stream:golive");
  if (!gate.ok) return gate.response;

  // The owner's plan, as for recording and the participant cap: billing is
  // per host. Operators are exempt.
  const owner = ev.ownerUserId || "";
  const { plan: ownerPlan, limits: ownerLimits } = await getPlanLimitsForUserId(owner);
  if (!ownerLimits.livestream && !(owner && (await isAdminUserId(owner)))) {
    return NextResponse.json(
      {
        ok: false,
        error: "plan_upgrade_required",
        feature: "livestream",
        plan: ownerPlan,
        message:
          "Livestreaming is on the Enterprise plan. The meeting's owner can arrange it at neoconference.app/pricing.",
      },
      { status: 402 }
    );
  }

  if (ev.livestream) {
    return NextResponse.json(
      { ok: false, error: "already_streaming", message: "This meeting is already being streamed. Stop it first to change where it goes." },
      { status: 409 }
    );
  }

  const raw = Array.isArray(body.destinations) ? (body.destinations as unknown[]) : [];
  const destinations: StreamDestinationInput[] = raw
    .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
    .map((d) => ({
      platform: String(d.platform || "") as StreamPlatform,
      key: typeof d.key === "string" ? d.key : "",
      label: typeof d.label === "string" ? d.label : undefined,
    }));
  if (destinations.length === 0) {
    return NextResponse.json({ ok: false, error: "no_destination", message: "Add at least one destination." }, { status: 400 });
  }
  if (destinations.length > MAX_DESTINATIONS) {
    return NextResponse.json(
      { ok: false, error: "too_many_destinations", message: `Up to ${MAX_DESTINATIONS} destinations at once.` },
      { status: 400 }
    );
  }
  for (const d of destinations) {
    const problem = destinationProblem(d);
    if (problem) return NextResponse.json({ ok: false, error: "bad_destination", message: problem }, { status: 400 });
  }

  try {
    const output = new StreamOutput({ protocol: StreamProtocol.RTMP, urls: destinations.map(rtmpUrlFor) });
    const info = await egressClient().startRoomCompositeEgress(room, output, { layout: "grid" });
    const state: LiveStreamState = {
      egressId: info.egressId,
      startedAt: new Date().toISOString(),
      startedBy: userId,
      destinations: destinations.map(publicDestination),
    };
    await eventStore.update(ev.id, (prev) => ({
      ...prev,
      livestream: state,
      state: prev.state === "live" ? prev.state : "live",
      startedAt: prev.startedAt || state.startedAt,
      updatedAt: state.startedAt,
    }));
    return NextResponse.json({ ok: true, ...state });
  } catch (e) {
    console.error("[egress/stream] start failed", e);
    return NextResponse.json({ ok: false, error: "stream_failed", message: errorMessage(e) || "Could not start the stream." }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });

  let body: { room?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // A DELETE with no body: the room may be in the query.
  }
  const room = (typeof body.room === "string" ? body.room : new URL(req.url).searchParams.get("room") || "").trim();
  if (!room) return NextResponse.json({ ok: false, error: "missing_room" }, { status: 400 });

  const ev = await eventFor(room);
  if (!ev) return NextResponse.json({ ok: false, error: "event_not_found" }, { status: 404 });
  const gate = await authorize(ev, "stream:golive");
  if (!gate.ok) return gate.response;
  if (!ev.livestream) return NextResponse.json({ ok: true, live: false, note: "not_streaming" });

  try {
    await egressClient().stopEgress(ev.livestream.egressId);
  } catch (e) {
    // Already finished, or LiveKit cannot find it: either way it is not
    // streaming, and the event must stop saying it is.
    console.warn("[egress/stream] stop:", errorMessage(e));
  }
  await eventStore.update(ev.id, (prev) => ({ ...prev, livestream: undefined, updatedAt: new Date().toISOString() }));
  return NextResponse.json({ ok: true, live: false });
}

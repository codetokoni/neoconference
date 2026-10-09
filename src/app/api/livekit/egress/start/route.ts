import { errorMessage } from "@/lib/errorMessage";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { authorize } from "@/lib/authz";
import { rememberEgressOwner } from "@/lib/recordingUsage";
import { activity } from "@/lib/activity";
import { recordingGate, startRoomRecording } from "@/lib/roomRecording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { room?: string };
    const room = (body.room || "").trim();
    if (!room) {
      return NextResponse.json({ error: "Missing room" }, { status: 400 });
    }

    // ---- Authz (F-2) ----
    // The LiveKit room name is the event slug. The room page always resolves
    // /api/events/role on mount, which adopts orphan rooms, so a room anybody
    // is actually sitting in always has an event record by the time this runs.
    // No record means the caller invented a room name: refuse rather than adopt.
    const ev = await eventStore.bySlug(room);
    if (!ev) {
      return NextResponse.json({ error: "event_not_found" }, { status: 404 });
    }
    const gate = await authorize(ev, "recording:start");
    if (!gate.ok) return gate.response;

    // Recording is a paid feature (planLimits.recording: Pro and above),
    // and billing is per host: the meeting owner's plan decides, as it does
    // for the participant cap in the token route. The UI hides Record on
    // other plans, but only this refuses it — the app, or anyone calling
    // the route, used to record on Free. No owner reads as Free, the same
    // fallback the token route puts in the room's metadata. Recording hours
    // per month (Pro 10, Business 50) are counted against the owner when
    // each recording finishes (lib/recordingUsage); operators are exempt.
    // The same rules record an API meeting (lib/roomRecording).
    const owner = ev.ownerUserId || "";
    const allowed = await recordingGate(owner);
    if (!allowed.ok) {
      return NextResponse.json(
        { error: allowed.code, feature: "recording", plan: allowed.plan, message: allowed.message },
        { status: allowed.code === "feature_disabled" ? 403 : 402 }
      );
    }

    // Files go in the folder of whoever pressed Record: the recordings
    // list/delete/rename APIs check that prefix, so users only ever see
    // their own recordings on the dashboard.
    const started = await startRoomRecording({ room, recorderUserId: userId });

    // The video egress is the one whose length counts (the audio sidecar
    // runs alongside it and is not counted twice).
    if (owner && !allowed.exempt) await rememberEgressOwner(started.egressId, owner);
    await activity.record("recording.started", { userId, account: owner || null, props: { eventId: ev.id, egressId: started.egressId } });

    return NextResponse.json({
      egressId: started.egressId,
      filepath: started.filepath,
      audioEgressId: started.audioEgressId,
      audioFilepath: started.audioFilepath,
      startedAt: Date.now(),
      // Near the monthly cap: said when the recording starts.
      ...(allowed.warning ? { warning: allowed.warning } : {}),
    });
  } catch (e) {
    console.error("egress/start failed", e);
    return NextResponse.json(
      { error: errorMessage(e) || "Failed to start egress" },
      { status: 500 }
    );
  }
}

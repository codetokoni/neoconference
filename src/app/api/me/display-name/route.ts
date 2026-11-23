// /api/me/display-name — the name others see in meetings (src/lib/attendeeName.ts
// chosenMeetingName). The web join screen's "Display name", "Change my name"
// in the meeting, and the app use it.
//
// GET   { name, chosen }        the name meetings show now, and whether the
//                               person chose it (false: the default, e.g. a
//                               KingsChat handle).
// POST  { name, room? }         chooses it: checked, saved on the account for
//                               every meeting from now on. "" goes back to the
//                               default. With `room` (the LiveKit room the
//                               caller is in), everyone there sees the new
//                               name at once.
//
// Only ever the caller's own account. The attendance name is separate and
// unchanged (/api/me/full-name).

import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { chosenMeetingName, cleanFullName, displayNameFor, meetingNameProblem } from "@/lib/attendeeName";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOM_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const user = await (await clerkClient()).users.getUser(userId);
  return NextResponse.json({ name: displayNameFor(user, userId), chosen: Boolean(chosenMeetingName(user)) }, { headers: { "cache-control": "no-store" } });
}

/** This person's connections in the room (a phone and a browser are two), renamed. */
async function renameIn(room: string, userId: string, name: string): Promise<number> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) return 0;
  const svc = new RoomServiceClient(url, apiKey, apiSecret);
  const mine = (await svc.listParticipants(room)).filter((p) => p.identity === userId || p.identity.startsWith(`${userId}#`));
  const done = await Promise.allSettled(mine.map((p) => svc.updateParticipant(room, p.identity, { name })));
  return done.filter((d) => d.status === "fulfilled").length;
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { name?: unknown; room?: unknown } | null;
  const typed = typeof body?.name === "string" ? body.name : "";
  const clearing = cleanFullName(typed) === "";
  if (!clearing) {
    const problem = meetingNameProblem(typed);
    if (problem) return NextResponse.json({ error: "invalid_name", message: problem }, { status: 400 });
  }
  const cc = await clerkClient();
  try {
    await cc.users.updateUserMetadata(userId, { publicMetadata: { meetingName: clearing ? null : cleanFullName(typed) } });
  } catch (err) {
    console.error("[display-name] could not save", err);
    return NextResponse.json({ error: "save_failed", message: "Your name could not be saved. Try again." }, { status: 502 });
  }
  const name = displayNameFor(await cc.users.getUser(userId), userId);
  // Everyone in the meeting sees it now. Best effort: it is saved either way,
  // and the next join shows it.
  let renamed = 0;
  const room = typeof body?.room === "string" ? body.room : "";
  if (ROOM_NAME_REGEX.test(room)) {
    try {
      renamed = await renameIn(room, userId, name);
    } catch (err) {
      console.warn("[display-name] could not rename in", room, err instanceof Error ? err.message : err);
    }
  }
  return NextResponse.json({ ok: true, name, chosen: !clearing, renamed });
}

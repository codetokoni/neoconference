// /api/livekit/mic-lock — lock participant microphones (src/lib/micLock.ts).
//
// GET  ?slug=<meeting>   { locked, allowed? }: anyone in the meeting may ask
//                        whether it is locked; Owner, Host and Moderator also
//                        get who is allowed to unmute.
// POST { slug, room?, action, participantIdentity? }
//   room: the LiveKit room the caller is in (the address they joined by,
//   which a renamed meeting may not share with its slug); it must belong to
//   the same meeting. Defaults to the slug.
//   "lock"     mute everyone but Owners, Hosts and Moderators, and keep them
//              from unmuting (late joiners and reconnects included)
//   "unlock"   everyone may unmute themselves; nobody is unmuted
//   "allow"    one person may unmute while the rest stay locked; their
//              microphone is not switched on
//   "relock"   that person is locked again (a live microphone is taken down)
//
// Every POST checks the caller's current meeting role (participant:micLock,
// Moderator rank) through authorize(), as every other moderation action.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import {
  announceMicLock,
  applyMicLock,
  baseIdentity,
  getMicLock,
  liveKitService,
  saveMicLock,
  type MicLockState,
} from "@/lib/micLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action = "lock" | "unlock" | "allow" | "relock";
const ACTIONS: Action[] = ["lock", "unlock", "allow", "relock"];

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("slug")?.trim();
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  const ev = await eventStore.bySlug(slug);
  if (!ev) return NextResponse.json({ error: "event_not_found" }, { status: 404 });
  const state = await getMicLock(ev.id);
  const mod = await authorize(ev, "participant:micLock");
  return NextResponse.json(
    mod.ok ? { locked: state.locked, allowed: state.allowed } : { locked: state.locked, youMayUnmute: state.allowed.includes(userId) },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { slug?: unknown; room?: unknown; action?: unknown; participantIdentity?: unknown } | null;
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const roomName = typeof body?.room === "string" && body.room.trim() ? body.room.trim() : slug;
  const action = typeof body?.action === "string" ? (body.action.trim() as Action) : null;
  const identity = typeof body?.participantIdentity === "string" ? body.participantIdentity.trim() : "";
  if (!slug || !action) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  if ((action === "allow" || action === "relock") && !identity) {
    return NextResponse.json({ error: "missing_participant" }, { status: 400 });
  }

  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ev = await eventStore.bySlug(slug);
  if (!ev) return NextResponse.json({ error: "event_not_found" }, { status: 404 });

  // The caller's role now, on every action.
  const gate = await authorize(ev, "participant:micLock");
  if (!gate.ok) return gate.response;
  if (roomName !== slug && (await eventStore.bySlug(roomName))?.id !== ev.id) {
    return NextResponse.json({ error: "room_not_this_meeting" }, { status: 400 });
  }

  const svc = await liveKitService();
  if (!svc) return NextResponse.json({ error: "livekit_misconfigured" }, { status: 500 });

  const prev = await getMicLock(ev.id);
  const target = identity ? baseIdentity(identity) : "";
  let next: MicLockState;
  switch (action) {
    case "lock":
      next = { locked: true, allowed: [] };
      break;
    case "unlock":
      next = { locked: false, allowed: [] };
      break;
    case "allow":
      if (!prev.locked) return NextResponse.json({ error: "not_locked", message: "Microphones are not locked." }, { status: 409 });
      next = { ...prev, allowed: Array.from(new Set([...prev.allowed, target])) };
      break;
    case "relock":
      if (!prev.locked) return NextResponse.json({ error: "not_locked", message: "Microphones are not locked." }, { status: 409 });
      next = { ...prev, allowed: prev.allowed.filter((u) => u !== target) };
      break;
  }
  next = { ...next, by: userId, at: Date.now() };
  await saveMicLock(ev.id, next);

  const room = roomName;
  let applied;
  try {
    applied = await applyMicLock(svc, room, next, target ? { only: target } : {});
  } catch (err) {
    // No such room yet (nobody in it): the state is saved, and every join
    // takes it from the token.
    console.warn("[mic-lock] could not apply to the room", room, err);
    applied = { changed: 0, unchanged: 0, failed: 0 };
  }
  await announceMicLock(svc, room, next);
  console.info("[mic-lock]", JSON.stringify({ event: ev.id, action, by: userId, ...applied }));
  return NextResponse.json({ ok: true, action, locked: next.locked, allowed: next.allowed, ...applied });
}

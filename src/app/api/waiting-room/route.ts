// src/app/api/waiting-room/route.ts
//
// Single-route waiting-room API for event-bound rooms.
//
// POST { op: 'knock', slug }                   - attendee asks to enter
// POST { op: 'decide', slug, entryId, decision: 'admit' | 'deny' }
//                                              - host/cohost approves or rejects
// POST { op: 'set', slug, enabled }            - host/cohost turns it on or off
// GET  ?slug=<event slug>                      - host/cohost lists pending queue
//
// Knock is idempotent: calling twice returns the same entry. Host operations
// require ownership or a 'host'/'cohost' RoleAssignment for the event.
//
// On admit, the entry's status is flipped to 'admitted', which the LiveKit
// token route lets through. That lasts until the room empties, and a
// refusal holds for a minute; see lib/waitingRoom.

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { isAdmin } from "@/lib/roles";
import { lastKnocks, noteKnock, refusalHolds, stillWaiting } from "@/lib/waitingRoom";
import type { NeoEvent, WaitingRoomEntry } from "@/types/event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CallerInfo {
  userId: string;
  emails: string[];
  displayName: string;
}

async function getCaller(): Promise<CallerInfo | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const u = await currentUser().catch(() => null);
  const emails = (u?.emailAddresses || []).map(
    (e: { emailAddress: string }) => e.emailAddress.toLowerCase()
  );
  const displayName =
    u?.fullName ||
    u?.username ||
    u?.primaryEmailAddress?.emailAddress ||
    userId;
  return { userId, emails, displayName };
}

function callerRole(ev: NeoEvent, caller: CallerInfo) {
  const isAdminCaller = caller.emails.some((e) => isAdmin(e));
  const ownerEmail = (ev.ownerEmail || "").toLowerCase();
  const isOwner =
    ev.ownerUserId === caller.userId ||
    (ownerEmail !== "" && caller.emails.includes(ownerEmail));
  const role = (ev.roles || []).find((r) => {
    const id = r.identifier.toLowerCase();
    return id === caller.userId.toLowerCase() || caller.emails.includes(id);
  });
  return {
    isOwner,
    role: role?.role,
    preApproved: Boolean(role?.preApproved),
    isHostlike: isAdminCaller || isOwner || role?.role === "host" || role?.role === "cohost",
  };
}

// ---------- POST: knock | decide ----------
export async function POST(req: Request) {
  const caller = await getCaller();
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const op = String(body.op || "").trim();
  const slug = String(body.slug || "").trim();
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }

  const ev = await eventStore.bySlug(slug);
  if (!ev) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (op === "knock") {
    return knock(ev, caller);
  }
  if (op === "decide") {
    const entryId = String(body.entryId || "").trim();
    const decision = String(body.decision || "");
    if (!entryId || (decision !== "admit" && decision !== "deny")) {
      return NextResponse.json({ error: "bad_args" }, { status: 400 });
    }
    return decide(ev, caller, entryId, decision as "admit" | "deny");
  }
  if (op === "set") {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "bad_args" }, { status: 400 });
    }
    return setEnabled(ev, caller, body.enabled);
  }
  return NextResponse.json({ error: "bad_op" }, { status: 400 });
}

// ---------- GET: list (host only) ----------
export async function GET(req: Request) {
  const caller = await getCaller();
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const slug = (url.searchParams.get("slug") || "").trim();
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }
  const ev = await eventStore.bySlug(slug);
  if (!ev) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const r = callerRole(ev, caller);
  if (!r.isHostlike) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // `enabled` rides along so a host's app, which polls this, shows the
  // switch as it is — including after someone changed it on the web.
  // Someone who stopped knocking has gone; they are left out of the list
  // (not the queue) until they knock again. If the knock times cannot be
  // read, show everyone rather than no one.
  const queue = ev.waitingRoom || [];
  let entries = queue;
  try {
    const pendingIds = queue.filter((e) => e.status === "pending").map((e) => e.id);
    entries = stillWaiting(queue, await lastKnocks(ev.id, pendingIds), Date.now());
  } catch (e) {
    console.warn("[waiting-room] could not read knock times", e);
  }
  return NextResponse.json({
    entries,
    enabled: Boolean(ev.waitingRoomEnabled),
  });
}

async function setEnabled(ev: NeoEvent, caller: CallerInfo, enabled: boolean) {
  // The same people who admit and refuse. The dashboard's PATCH is the
  // owner's alone and edits the whole event; a co-host running the
  // meeting needs this one switch, from inside it.
  const r = callerRole(ev, caller);
  if (!r.isHostlike) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Turning it off needs nothing else: a knock on a room without a
  // waiting room is answered "admitted", so anyone waiting walks in on
  // their next knock.
  await eventStore.update(ev.id, (prev) => ({
    ...prev,
    waitingRoomEnabled: enabled,
    updatedAt: new Date().toISOString(),
  }));
  return NextResponse.json({ ok: true, enabled });
}

// ---------- handlers ----------
async function knock(ev: NeoEvent, caller: CallerInfo) {
  const r = callerRole(ev, caller);
  if (r.isHostlike || r.preApproved) {
    return NextResponse.json({ status: "admitted", entryId: caller.userId });
  }
  if (!ev.waitingRoomEnabled) {
    return NextResponse.json({ status: "admitted", entryId: caller.userId });
  }

  const now = Date.now();
  const existing = (ev.waitingRoom || []).find((e) => e.id === caller.userId);
  // A refusal answers for a minute, then a knock is a new request — it used
  // to answer every knock forever (see lib/waitingRoom).
  if (existing && (existing.status !== "denied" || refusalHolds(existing, now))) {
    if (existing.status === "pending") await markKnock(ev.id, caller.userId, now);
    return NextResponse.json({ status: existing.status, entryId: existing.id });
  }

  const entry: WaitingRoomEntry = {
    id: caller.userId,
    name: caller.displayName,
    email: caller.emails[0],
    requestedAt: now,
    status: "pending",
  };

  // Replaces a spent refusal rather than adding beside it; one entry each.
  await eventStore.update(ev.id, (prev) => ({
    ...prev,
    waitingRoom: [
      ...(prev.waitingRoom || []).filter((e) => e.id !== entry.id),
      entry,
    ],
    updatedAt: new Date().toISOString(),
  }));
  await markKnock(ev.id, caller.userId, now);

  return NextResponse.json({ status: "pending", entryId: entry.id });
}

/** Best effort: a knock that could not be timed is still a knock. */
async function markKnock(eventId: string, userId: string, now: number) {
  try {
    await noteKnock(eventId, userId, now);
  } catch (e) {
    console.warn("[waiting-room] could not record knock", e);
  }
}

async function decide(
  ev: NeoEvent,
  caller: CallerInfo,
  entryId: string,
  decision: "admit" | "deny"
) {
  const r = callerRole(ev, caller);
  if (!r.isHostlike) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const queue = ev.waitingRoom || [];
  const target = queue.find((e) => e.id === entryId);
  if (!target) {
    return NextResponse.json({ error: "entry_not_found" }, { status: 404 });
  }

  // Only the queue entry changes. Admitting used to also write a
  // pre-approved viewer role, which nothing ever removed: the person then
  // skipped this room's waiting room for good. The admitted entry is what
  // the token route checks, and it is cleared when the room empties.
  const decidedAt = Date.now();
  await eventStore.update(ev.id, (prev) => {
    const nextQueue: WaitingRoomEntry[] = (prev.waitingRoom || []).map((e) =>
      e.id === entryId
        ? { ...e, status: decision === "admit" ? "admitted" : "denied", decidedAt }
        : e
    );
    return {
      ...prev,
      waitingRoom: nextQueue,
      updatedAt: new Date().toISOString(),
    };
  });

  return NextResponse.json({ ok: true });
}

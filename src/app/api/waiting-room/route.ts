// src/app/api/waiting-room/route.ts
//
// Single-route waiting-room API for event-bound rooms.
//
// POST { op: 'knock', slug }                   - attendee asks to enter
// POST { op: 'decide', slug, entryId, decision: 'admit' | 'deny' }
//                                              - host/cohost approves or rejects
// GET  ?slug=<event slug>                      - host/cohost lists pending queue
//
// Knock is idempotent: calling twice returns the same entry. Host operations
// require ownership or a 'host'/'cohost' RoleAssignment for the event.
//
// On admit, the entry's status is flipped to 'admitted' AND the user is
// added to event.roles with preApproved=true so the LiveKit token route
// will let them through on the next attempt.

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import type { NeoEvent, RoleAssignment, WaitingRoomEntry } from "@/types/event";

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
  const isOwner = ev.ownerUserId === caller.userId;
  const role = (ev.roles || []).find((r) => {
    const id = r.identifier.toLowerCase();
    return id === caller.userId.toLowerCase() || caller.emails.includes(id);
  });
  return {
    isOwner,
    role: role?.role,
    preApproved: Boolean(role?.preApproved),
    isHostlike: isOwner || role?.role === "host" || role?.role === "cohost",
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
  return NextResponse.json({ entries: ev.waitingRoom || [] });
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

  const existing = (ev.waitingRoom || []).find((e) => e.id === caller.userId);
  if (existing) {
    return NextResponse.json({ status: existing.status, entryId: existing.id });
  }

  const entry: WaitingRoomEntry = {
    id: caller.userId,
    name: caller.displayName,
    email: caller.emails[0],
    requestedAt: Date.now(),
    status: "pending",
  };

  await eventStore.update(ev.id, (prev) => ({
    ...prev,
    waitingRoom: [...(prev.waitingRoom || []), entry],
    updatedAt: new Date().toISOString(),
  }));

  return NextResponse.json({ status: "pending", entryId: entry.id });
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

  await eventStore.update(ev.id, (prev) => {
    const nextQueue: WaitingRoomEntry[] = (prev.waitingRoom || []).map((e) =>
      e.id === entryId
        ? { ...e, status: decision === "admit" ? "admitted" : "denied" }
        : e
    );
    let nextRoles: RoleAssignment[] = prev.roles || [];
    if (decision === "admit") {
      const found = nextRoles.find(
        (rr) => rr.identifier.toLowerCase() === entryId.toLowerCase()
      );
      if (found) {
        nextRoles = nextRoles.map((rr) =>
          rr.identifier.toLowerCase() === entryId.toLowerCase()
            ? { ...rr, preApproved: true }
            : rr
        );
      } else {
        nextRoles = [
          ...nextRoles,
          {
            identifier: entryId,
            role: "viewer",
            label: target.name,
            preApproved: true,
          },
        ];
      }
    }
    return {
      ...prev,
      waitingRoom: nextQueue,
      roles: nextRoles,
      updatedAt: new Date().toISOString(),
    };
  });

  return NextResponse.json({ ok: true });
}

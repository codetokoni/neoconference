// src/app/api/breakouts/[slug]/route.ts
//
// REST API for breakout-room state, keyed by event slug.
//
// GET    /api/breakouts/<slug>  -> { state: BreakoutState | null }
//                                    Any authenticated user can read.
// PUT    /api/breakouts/<slug>  body: BreakoutState
//                                    Owner / host / cohost only.
// DELETE /api/breakouts/<slug>  -> { ok: true }
//                                    Owner / host / cohost only.
//
// Auth pattern mirrors /api/waiting-room: resolves the caller via Clerk,
// looks up the event via eventStore.bySlug, and checks ownership or a
// 'host'/'cohost' role assignment.

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { breakoutsStore, type BreakoutState } from "@/lib/breakoutsStore";
import type { NeoEvent } from "@/types/event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CallerInfo {
  userId: string;
  emails: string[];
}

async function getCaller(): Promise<CallerInfo | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const u = await currentUser().catch(() => null);
  const emails = (u?.emailAddresses || []).map(
    (e: { emailAddress: string }) => e.emailAddress.toLowerCase()
  );
  return { userId, emails };
}

function isHostlike(ev: NeoEvent, caller: CallerInfo): boolean {
  if (ev.ownerUserId === caller.userId) return true;
  const role = (ev.roles || []).find((r) => {
    const id = r.identifier.toLowerCase();
    return id === caller.userId.toLowerCase() || caller.emails.includes(id);
  });
  return role?.role === "host" || role?.role === "cohost";
}

function validState(x: any): x is BreakoutState {
  if (!x || typeof x !== "object") return false;
  if (typeof x.active !== "boolean") return false;
  if (!Array.isArray(x.groups)) return false;
  if (typeof x.assignments !== "object" || x.assignments === null) return false;
  if (typeof x.ts !== "number") return false;
  for (const g of x.groups) {
    if (!g || typeof g.id !== "string" || typeof g.name !== "string") return false;
  }
  for (const [k, v] of Object.entries(x.assignments)) {
    if (typeof k !== "string" || typeof v !== "string") return false;
  }
  return true;
}

// ---------- GET ----------
export async function GET(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  const caller = await getCaller();
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const slug = (params?.slug || "").trim();
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }
  const ev = await eventStore.bySlug(slug);
  if (!ev) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const state = await breakoutsStore.get(slug);
  return NextResponse.json({ state });
}

// ---------- PUT ----------
export async function PUT(
  req: Request,
  { params }: { params: { slug: string } }
) {
  const caller = await getCaller();
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const slug = (params?.slug || "").trim();
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }
  const ev = await eventStore.bySlug(slug);
  if (!ev) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!isHostlike(ev, caller)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!validState(body)) {
    return NextResponse.json({ error: "bad_state" }, { status: 400 });
  }
  const saved = await breakoutsStore.set(slug, body);
  return NextResponse.json({ state: saved });
}

// ---------- DELETE ----------
export async function DELETE(
  _req: Request,
  { params }: { params: { slug: string } }
) {
  const caller = await getCaller();
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const slug = (params?.slug || "").trim();
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }
  const ev = await eventStore.bySlug(slug);
  if (!ev) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!isHostlike(ev, caller)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await breakoutsStore.clear(slug);
  return NextResponse.json({ ok: true });
}

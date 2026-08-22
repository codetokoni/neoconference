// src/app/api/events/[id]/timer/route.ts
//
// FRS §10 meeting timer state.
//
// GET  — return current state. No authorization: everyone in the room needs
//        to be able to derive their remaining-time display, and visibility
//        gating on the "admins-only" mode happens client-side (the state
//        object carries a `visibility` field that participants respect).
//
// POST — apply a state transition. Body: { action, ... } — see the
//        TimerAction union in @/lib/timer for the exact shape. Requires
//        the timer:manage permission (RANK.moderator per FRS §10 which
//        assigns timer control to Owner/Host/Moderator).
//
// Path param: id or slug via byId ?? bySlug fallthrough.

import { NextResponse, type NextRequest } from "next/server";
import { authorize } from "@/lib/authz";
import { eventStore } from "@/lib/eventStore";
import {
  applyTimerAction,
  getTimer,
  type TimerAction,
  type TimerVisibility,
} from "@/lib/timer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const event = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!event) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const state = await getTimer(event.id);
  return NextResponse.json({ ok: true, state });
}

const VISIBILITIES = new Set<TimerVisibility>(["everyone", "admins"]);

function parseAction(raw: unknown): TimerAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { action?: unknown; durationMs?: unknown; deltaMs?: unknown; visibility?: unknown };
  const action = typeof r.action === "string" ? r.action : "";
  switch (action) {
    case "set": {
      if (typeof r.durationMs !== "number" || !Number.isFinite(r.durationMs)) return null;
      const visibility = typeof r.visibility === "string" && VISIBILITIES.has(r.visibility as TimerVisibility)
        ? (r.visibility as TimerVisibility)
        : undefined;
      return { action: "set", durationMs: r.durationMs, visibility };
    }
    case "start":
    case "pause":
    case "resume":
    case "reset":
      return { action } as TimerAction;
    case "adjust":
      if (typeof r.deltaMs !== "number" || !Number.isFinite(r.deltaMs)) return null;
      return { action: "adjust", deltaMs: r.deltaMs };
    case "visibility":
      if (typeof r.visibility !== "string" || !VISIBILITIES.has(r.visibility as TimerVisibility)) return null;
      return { action: "visibility", visibility: r.visibility as TimerVisibility };
    default:
      return null;
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const event = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!event) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const gate = await authorize(event, "timer:manage");
  if (!gate.ok) return gate.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = parseAction(raw);
  if (!action) return NextResponse.json({ error: "invalid_action" }, { status: 400 });

  const state = await applyTimerAction(event.id, action);
  return NextResponse.json({ ok: true, state });
}

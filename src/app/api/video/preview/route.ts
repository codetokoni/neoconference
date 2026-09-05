import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side preview pointer, shared across operators.
 *
 * Preview is a broadcast concept — the participant a producer is checking
 * BEFORE the audience sees them. Storing it in KV rather than in client
 * state means every operator (and every open cameras board) sees the same
 * thing; two producers cannot silently be checking two different tiles.
 * Compare this to the featured pointer, which is what /video/dashboard
 * actually shows on air.
 */

interface PreviewState {
  streamId: string;
  label: string;
  at: number;
}

const previewKey = (room: string) => `neo:video:preview:${room}`;

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

async function guard() {
  const actor = await requireRole(["admin", "staff"]);
  return actor
    ? null
    : NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
}

export async function GET(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const r = room(req);
  const state = await kv.get<PreviewState>(previewKey(r));
  return NextResponse.json(
    { ok: true, preview: state ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** streamId:null clears preview; anything else sets it. */
export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const r = room(req);

  let body: { streamId?: unknown; label?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  if (body.streamId === null) {
    await kv.del(previewKey(r));
    return NextResponse.json({ ok: true, preview: null });
  }

  const streamId = String(body.streamId ?? "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 128);
  if (!streamId) {
    return NextResponse.json({ ok: false, error: "streamId required" }, { status: 400 });
  }
  const label = String(body.label ?? "").slice(0, 80).trim() || streamId;
  const state: PreviewState = { streamId, label, at: Date.now() };
  await kv.set(previewKey(r), state);
  return NextResponse.json({ ok: true, preview: state });
}

export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const r = room(req);
  await kv.del(previewKey(r));
  return NextResponse.json({ ok: true, preview: null });
}

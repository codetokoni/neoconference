import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN, featuredKey, type FeaturedState } from "@/lib/simulcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

/**
 * Puts one participant on air, or clears back to the programme feed.
 *
 * Featuring is deliberately NOT a mixing operation: the watch page opens a
 * second peer connection straight to the participant's own stream id and
 * swaps the rendered element once it has frames. Nothing is re-encoded, and
 * clearing is instant because the programme connection was never dropped.
 *
 * Staff only. This route is not in the middleware's public matcher.
 */
export async function POST(req: Request) {
  const actor = await requireRole(["admin", "staff"]);
  if (!actor) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const r = room(req);

  let body: { streamId?: string | null; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const streamId = String(body.streamId ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 128);

  if (!streamId) {
    await kv.del(featuredKey(r));
    return NextResponse.json({ ok: true, featured: null });
  }

  const featured: FeaturedState = {
    streamId,
    label: String(body.label ?? streamId)
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, 64),
    at: Date.now(),
  };

  await kv.set(featuredKey(r), featured);
  return NextResponse.json({ ok: true, featured });
}

export async function GET(req: Request) {
  const featured = await kv.get<FeaturedState>(featuredKey(room(req)));
  return NextResponse.json(
    { ok: true, featured: featured ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

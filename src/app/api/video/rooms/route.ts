import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import {
  createRoom,
  getRoom,
  isValidSlug,
  listRooms,
  normaliseSlug,
} from "@/lib/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard() {
  const actor = await requireRole(["admin", "staff"]);
  return actor
    ? null
    : NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  const rooms = await listRooms();
  return NextResponse.json(
    { ok: true, rooms },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Create a room. Slug is derived from `name` when the client omits one.
 * slotCount clamps to 1..500 — a Vercel KV hash can hold thousands, but
 * a producer scrolling 500+ tiles is already beyond what one operator
 * should handle.
 */
export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  let body: { slug?: unknown; name?: unknown; slotCount?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const name = String(body.name ?? "").trim().slice(0, 60);
  if (!name) {
    return NextResponse.json({ ok: false, error: "Name required." }, { status: 400 });
  }
  const slug = normaliseSlug(String(body.slug ?? "") || name);
  if (!slug || !isValidSlug(slug)) {
    return NextResponse.json({ ok: false, error: "Bad slug." }, { status: 400 });
  }
  const slotCount = Math.max(1, Math.min(500, Number(body.slotCount ?? 50) || 50));

  const existing = await getRoom(slug);
  if (existing) {
    return NextResponse.json(
      { ok: false, error: "A room with that slug already exists." },
      { status: 409 },
    );
  }

  const room = await createRoom(slug, name, slotCount);
  return NextResponse.json({ ok: true, room });
}

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import {
  createQueue,
  isValidSlug,
  listQueues,
  normaliseSlug,
  RESERVED_QUEUE_SLUGS,
} from "@/lib/videoQueues";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

// Requires a signed-in Clerk account — see the note on
// src/app/video/room/moderate/page.tsx.
async function guard() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** List every queue on a room. */
export async function GET(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const r = room(req);
  const queues = await listQueues(r);
  return NextResponse.json(
    { ok: true, room: r, queues },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Create a queue. Slug is derived from `name` when the client omits one. */
export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const r = room(req);

  let body: { slug?: unknown; name?: unknown };
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
  if (!slug) {
    return NextResponse.json({ ok: false, error: "Bad slug." }, { status: 400 });
  }
  if (RESERVED_QUEUE_SLUGS.has(slug)) {
    // Explicit message so admins immediately know why "moderate",
    // "cameras", "queue", … aren't accepted — those names collide
    // with existing pages under /video/room/<name> and would be
    // unreachable at the short URL.
    return NextResponse.json(
      {
        ok: false,
        error: `"${slug}" is a reserved name — pick another (avoid: ${Array.from(RESERVED_QUEUE_SLUGS).join(", ")}).`,
      },
      { status: 400 },
    );
  }
  if (!isValidSlug(slug)) {
    return NextResponse.json({ ok: false, error: "Bad slug." }, { status: 400 });
  }

  const queue = await createQueue(r, slug, name);
  return NextResponse.json({ ok: true, queue });
}

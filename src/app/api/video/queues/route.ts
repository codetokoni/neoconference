import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import {
  createQueue,
  isValidSlug,
  listQueues,
  normaliseSlug,
} from "@/lib/videoQueues";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (!slug || !isValidSlug(slug)) {
    return NextResponse.json({ ok: false, error: "Bad slug." }, { status: 400 });
  }

  const queue = await createQueue(r, slug, name);
  return NextResponse.json({ ok: true, queue });
}

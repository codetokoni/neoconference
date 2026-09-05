import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import { deleteQueue, getQueue, updateQueue } from "@/lib/videoQueues";

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

function slugFromParams(params: { slug?: string }) {
  return String(params.slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}

export async function GET(req: Request, ctx: { params: { slug: string } }) {
  const denied = await guard();
  if (denied) return denied;
  const r = room(req);
  const slug = slugFromParams(ctx.params);
  const q = await getQueue(r, slug);
  if (!q) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  return NextResponse.json(
    { ok: true, queue: q },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Partial update of a queue. `name` renames it, `order` replaces the
 * entry list wholesale. Clients that reorder or add/remove entries send
 * the full new order — cheaper than a bespoke insert/delete/move endpoint
 * for a list this small, and it side-steps CAS races because whoever
 * writes last wins per-queue.
 */
export async function PATCH(req: Request, ctx: { params: { slug: string } }) {
  const denied = await guard();
  if (denied) return denied;
  const r = room(req);
  const slug = slugFromParams(ctx.params);

  let body: { name?: unknown; order?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const patch: { name?: string; order?: string[] } = {};
  if (typeof body.name === "string") {
    patch.name = body.name.slice(0, 60).trim();
    if (!patch.name) {
      return NextResponse.json({ ok: false, error: "Bad name." }, { status: 400 });
    }
  }
  if (Array.isArray(body.order)) {
    patch.order = body.order
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128))
      .filter(Boolean)
      .slice(0, 200);
  }

  const q = await updateQueue(r, slug, patch);
  if (!q) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, queue: q });
}

export async function DELETE(req: Request, ctx: { params: { slug: string } }) {
  const denied = await guard();
  if (denied) return denied;
  const r = room(req);
  const slug = slugFromParams(ctx.params);
  await deleteQueue(r, slug);
  return NextResponse.json({ ok: true });
}

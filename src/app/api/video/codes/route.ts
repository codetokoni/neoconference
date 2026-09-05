import { NextResponse } from "next/server";
import { requireRole } from "@/lib/roles";
import { SIMULCAST_MAIN } from "@/lib/simulcast";
import {
  claimedCodes,
  listCodes,
  mintCodes,
  releaseCode,
} from "@/lib/participantCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SLOTS = 500;

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

/** Staff only — this route is not in the middleware's public matcher. */
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
  const [codes, claimed] = await Promise.all([listCodes(r), claimedCodes(r)]);

  return NextResponse.json(
    {
      ok: true,
      room: r,
      codes: codes.map((c) => ({ ...c, claimed: claimed.has(c.code) })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Mint codes for slots 1..count, reusing the room's existing prefix. */
export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);

  let body: { count?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const count = Math.max(1, Math.min(MAX_SLOTS, Number(body.count) || 0));
  const { prefix, codes } = await mintCodes(r, count);

  return NextResponse.json({ ok: true, room: r, prefix, count: codes.length, codes });
}

/** Frees a claim so the code can be used on a different device. */
export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  const r = room(req);
  const code = new URL(req.url).searchParams.get("code")?.trim();
  if (!code) {
    return NextResponse.json({ ok: false, error: "code required" }, { status: 400 });
  }

  await releaseCode(r, code);
  return NextResponse.json({ ok: true, released: code });
}

import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { AMS_WS, SIMULCAST_MAIN } from "@/lib/simulcast";
import { claimCode, releaseCode, roomMainTrack } from "@/lib/participantCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_WINDOW = 30; // seconds
const RATE_MAX = 10; // code attempts per window per IP

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

function clientIp(req: Request) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

/**
 * Exchanges a personal code for a publishing slot.
 *
 * Public on purpose — participants have no account. The code is the
 * credential, so this route is rate limited hard enough that guessing one is
 * not worth the effort, and a claim is bound to the device that made it.
 */
export async function POST(req: Request) {
  const r = room(req);
  const ip = clientIp(req);

  const rlKey = `neo:video:joinrl:${ip}`;
  const hits = await kv.incr(rlKey);
  if (hits === 1) await kv.expire(rlKey, RATE_WINDOW);
  if (hits > RATE_MAX) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Wait a moment and try again." },
      { status: 429 },
    );
  }

  let body: { code?: string; deviceId?: string; leave?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const code = String(body.code ?? "").slice(0, 16);
  const deviceId = String(body.deviceId ?? "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 64);

  if (!code || !deviceId) {
    return NextResponse.json({ ok: false, error: "Enter your code." }, { status: 400 });
  }

  if (body.leave) {
    await releaseCode(r, code);
    return NextResponse.json({ ok: true, left: true });
  }

  const claim = await claimCode(r, code, deviceId);
  if (!claim.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          claim.reason === "in_use"
            ? "That code is already in use on another device."
            : "That code is not on the list for this event.",
      },
      { status: claim.reason === "in_use" ? 409 : 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    rejoined: claim.rejoined,
    slot: claim.entry.slot,
    name: claim.entry.name,
    streamId: claim.entry.streamId,
    mainTrack: roomMainTrack(r),
    wsUrl: AMS_WS,
  });
}

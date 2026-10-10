import { NextResponse } from "next/server";
import { kv } from "@/lib/kv";
import { createHash } from "node:crypto";
import { AMS_WS, SIMULCAST_MAIN, liveState } from "@/lib/simulcast";
import {
  checkJoinSession,
  claimCode,
  createJoinSession,
  lookupCode,
  releaseCode,
  roomMainTrack,
} from "@/lib/participantCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_WINDOW = 30; // seconds
const RATE_MAX = 10; // code attempts per window per IP

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

/** 8 hex characters standing for a device id in the logs. */
function fingerprint(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
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

  let body: { code?: string; deviceId?: string; leave?: boolean; check?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  // A joined page asking whether it may keep its slot. Not rate limited:
  // every camera in a venue checks every few seconds, often from one
  // address, and the session token cannot be guessed.
  if (typeof body.check === "string") {
    const c = await checkJoinSession(body.check.slice(0, 64));
    if (!c.keep) {
      console.info(
        "[video-join] " +
          JSON.stringify({ room: c.room, slot: c.slot, outcome: c.reason === "signed_out" ? "stopped_signed_out" : "stopped_elsewhere" }),
      );
    }
    return NextResponse.json(c.keep ? { ok: true, keep: true } : { ok: true, keep: false, reason: c.reason });
  }

  const rlKey = `neo:video:joinrl:${ip}`;
  const hits = await kv.incr(rlKey);
  if (hits === 1) await kv.expire(rlKey, RATE_WINDOW);
  if (hits > RATE_MAX) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Wait a moment and try again." },
      { status: 429 },
    );
  }

  const code = String(body.code ?? "").slice(0, 16);
  const deviceId = String(body.deviceId ?? "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 64);

  if (!code || !deviceId) {
    return NextResponse.json({ ok: false, error: "Enter your code." }, { status: 400 });
  }

  if (body.leave) {
    const left = await lookupCode(r, code);
    await releaseCode(r, code);
    console.info(
      "[video-join] " +
        JSON.stringify({ room: r, slot: left?.slot ?? null, outcome: "left", device: fingerprint(deviceId) }),
    );
    return NextResponse.json({ ok: true, left: true });
  }

  // Whether AMS said the slot was live when another device held the code;
  // an unanswered call counts as live, so the lock stands on a guess.
  let ams: "live" | "not_live" | "no_answer" | "not_asked" = "not_asked";
  const claim = await claimCode(r, code, deviceId, async (streamId) => {
    ams = await liveState(streamId);
    return ams !== "not_live";
  });

  // One line per attempt, so a "code in use" complaint can be checked
  // against what happened: the slot, the outcome, what AMS said, and short
  // fingerprints of the device trying and the device holding the code.
  // Never the code itself — it is the participant's credential.
  console.info(
    "[video-join] " +
      JSON.stringify({
        room: r,
        slot: claim.ok || claim.reason === "in_use" ? claim.entry.slot : null,
        outcome: claim.ok ? claim.how : claim.reason,
        ams,
        device: fingerprint(deviceId),
        holder: !claim.ok && claim.reason === "in_use"
          ? fingerprint(claim.holder)
          : claim.ok && claim.previousHolder
            ? fingerprint(claim.previousHolder)
            : null,
      }),
  );

  if (!claim.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          claim.reason === "in_use"
            ? "That code is live on another device right now. Press Leave there, or close it, then try again."
            : "That code is not on the list for this event.",
      },
      { status: claim.reason === "in_use" ? 409 : 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    session: await createJoinSession(r, code, deviceId),
    rejoined: claim.rejoined,
    slot: claim.entry.slot,
    name: claim.entry.name,
    streamId: claim.entry.streamId,
    mainTrack: roomMainTrack(r),
    wsUrl: AMS_WS,
  });
}

// GET /api/livekit/capacity (signed in)
//
// { full: boolean, message? } — whether the whole LiveKit account is full
// now (src/lib/livekitCapacity.ts), for a room or app whose connection
// LiveKit just refused. The token route refuses joins once the account is
// full, but its count is a few seconds old: someone let in at that moment
// can still be refused by LiveKit itself, which only says "could not
// connect". Asked then, this says whether that was a full meeting, so they
// are told so instead of a connection error. Numbers are not given out.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { capacityRefusal, connectedNow } from "@/lib/livekitCapacity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !wsUrl) return NextResponse.json({ full: false });
  const refusal = capacityRefusal(await connectedNow(new RoomServiceClient(wsUrl, apiKey, apiSecret)), false);
  return NextResponse.json(refusal ? { full: true, message: refusal.message } : { full: false }, { headers: { "cache-control": "no-store" } });
}

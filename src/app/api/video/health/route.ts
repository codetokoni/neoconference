import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { kv } from "@vercel/kv";
import { AMS_HTTP, SIMULCAST_MAIN, featuredKey } from "@/lib/simulcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-glance ops summary for a room. Aggregates the pieces a
 * moderator needs to know are healthy before opening doors:
 *
 *   - programme    → is the AMS main track's HLS playlist reachable?
 *   - storage      → does Vercel KV respond?
 *   - translation  → is the translation worker's /healthz answering?
 *
 * Every probe runs in parallel with its own short timeout so a
 * single slow dependency can't hang the strip. Anything that throws
 * or times out reports "down" with a short reason — never a stack
 * trace, since this endpoint is called from the moderator hub and
 * moderators are not the audience for debugging output.
 *
 * Requires a signed-in Clerk account — matches every other
 * /api/video/room/* read.
 */

type CheckStatus = "ok" | "degraded" | "down" | "off";

interface Check {
  status: CheckStatus;
  latencyMs: number | null;
  detail: string;
}

interface HealthResponse {
  ok: true;
  room: string;
  at: number;
  checks: {
    programme: Check;
    storage: Check;
    translation: Check;
  };
}

function normaliseRoom(req: Request): string {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

/** Time a promise; convert throws into a "down" result. */
async function probe(
  name: string,
  fn: () => Promise<Check>,
  timeoutMs: number,
): Promise<Check> {
  const started = Date.now();
  try {
    const winner = await Promise.race<Check>([
      fn(),
      new Promise<Check>((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: "down",
              latencyMs: Date.now() - started,
              detail: `${name} timed out after ${timeoutMs}ms`,
            }),
          timeoutMs,
        ),
      ),
    ]);
    return winner;
  } catch (e) {
    return {
      status: "down",
      latencyMs: Date.now() - started,
      detail: (e as Error).message || `${name} threw`,
    };
  }
}

async function checkProgramme(room: string): Promise<Check> {
  const started = Date.now();
  // The main track publishes as `${room}-room` — HLS playlist lives
  // at ${AMS_HTTP}/streams/${room}-room.m3u8. HEAD is enough; a 200
  // means AMS is serving the manifest, a 404 means the broadcaster
  // isn't pushing right now.
  const url = `${AMS_HTTP}/streams/${encodeURIComponent(room + "-room")}.m3u8`;
  const r = await fetch(url, {
    method: "HEAD",
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
  const latencyMs = Date.now() - started;
  if (r.status === 200) return { status: "ok", latencyMs, detail: "HLS 200" };
  if (r.status === 404)
    return { status: "off", latencyMs, detail: "not broadcasting" };
  return { status: "degraded", latencyMs, detail: `HLS ${r.status}` };
}

async function checkStorage(room: string): Promise<Check> {
  const started = Date.now();
  // Featured pointer is one of the smallest KV values we set. Any
  // hash key would work; this one is naturally per-room so we're
  // reading room-scoped data rather than a synthetic ping key.
  await kv.get(featuredKey(room));
  return {
    status: "ok",
    latencyMs: Date.now() - started,
    detail: "KV reachable",
  };
}

async function checkTranslation(): Promise<Check> {
  const started = Date.now();
  const base = process.env.NEXT_PUBLIC_TRANSLATION_SSE || process.env.TRANSLATION_SSE || "";
  if (!base) {
    return { status: "off", latencyMs: null, detail: "worker not configured" };
  }
  const url = base.replace(/\/$/, "") + "/healthz";
  const r = await fetch(url, {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
  const latencyMs = Date.now() - started;
  if (r.ok) return { status: "ok", latencyMs, detail: `healthz ${r.status}` };
  return { status: "down", latencyMs, detail: `healthz ${r.status}` };
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const room = normaliseRoom(req);

  // Run every probe in parallel so the slowest one bounds the wall
  // clock, not the sum. Each has its own timeout via `probe`.
  const [programme, storage, translation] = await Promise.all([
    probe("programme", () => checkProgramme(room), 4000),
    probe("storage", () => checkStorage(room), 3000),
    probe("translation", () => checkTranslation(), 4000),
  ]);

  const body: HealthResponse = {
    ok: true,
    room,
    at: Date.now(),
    checks: { programme, storage, translation },
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

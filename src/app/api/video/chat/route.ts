import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { SIMULCAST_MAIN, type ChatMessage } from "@/lib/simulcast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAP = 200;          // messages retained per room
const MAX_TEXT = 300;
const MAX_NAME = 24;
const RATE_WINDOW = 10;   // seconds
const RATE_MAX = 5;       // messages per window per IP

const roomKey = (r: string) => `neo:videochat:${r}`;
const seqKey = (r: string) => `neo:videochat:${r}:seq`;

function room(req: Request) {
  const r = new URL(req.url).searchParams.get("room")?.trim();
  return (r || SIMULCAST_MAIN).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
}

function clean(s: unknown, max: number) {
  return String(s ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

export async function GET(req: Request) {
  const r = room(req);
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0) || 0;

  const raw = await kv.lrange<ChatMessage | string>(roomKey(r), 0, CAP - 1);
  const msgs = (raw ?? [])
    .map((m) => (typeof m === "string" ? (JSON.parse(m) as ChatMessage) : m))
    .filter((m): m is ChatMessage => !!m && m.seq > after)
    .sort((a, b) => a.seq - b.seq);

  return NextResponse.json(
    { ok: true, messages: msgs, cursor: msgs.length ? msgs[msgs.length - 1].seq : after },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const r = room(req);

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "anon";

  const rlKey = `neo:videochat:rl:${r}:${ip}`;
  const hits = await kv.incr(rlKey);
  if (hits === 1) await kv.expire(rlKey, RATE_WINDOW);
  if (hits > RATE_MAX) {
    return NextResponse.json({ ok: false, error: "Slow down a moment." }, { status: 429 });
  }

  let body: { name?: string; text?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const text = clean(body.text, MAX_TEXT);
  const name = clean(body.name, MAX_NAME) || "Guest";
  const code = clean(body.code, 4).toUpperCase();
  if (!text) {
    return NextResponse.json({ ok: false, error: "Message is empty." }, { status: 400 });
  }

  const msg: ChatMessage = {
    seq: await kv.incr(seqKey(r)),
    ts: Date.now(),
    name,
    code,
    text,
  };

  await kv.lpush(roomKey(r), JSON.stringify(msg));
  await kv.ltrim(roomKey(r), 0, CAP - 1);

  return NextResponse.json({ ok: true, message: msg });
}

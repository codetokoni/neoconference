// src/app/api/events/[id]/chat/route.ts
//
// GET  -> recent chat (public if event is public)
// POST -> append message (must be authenticated)

import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { chatStore } from '@/lib/chatStore';
import type { ChatMessage } from '@/types/event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


async function findEvent(idOrSlugOrRoom: string) {
  let ev = await eventStore.byId(idOrSlugOrRoom);
  if (ev) return ev;
  ev = await eventStore.bySlug(idOrSlugOrRoom);
  if (ev) return ev;
  try {
    const all = await eventStore.listAll();
    return all.find((e) => (e as any).livekitRoom === idOrSlugOrRoom) || null;
  } catch { return null; }
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const ev = await findEvent(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const messages = await chatStore.list(ev.id);
  return NextResponse.json({ messages });
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ev = await findEvent(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch {}
  const text = String(body?.text || "").trim();
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });
  // Optional reply context
  let replyTo: { id: string; name: string; snippet: string } | undefined;
  if (body?.replyTo && typeof body.replyTo === 'object') {
    const rid = String(body.replyTo.id || '').slice(0, 64);
    const rname = String(body.replyTo.name || '').slice(0, 80);
    const rsnip = String(body.replyTo.snippet || '').slice(0, 140);
    if (rid && rname) replyTo = { id: rid, name: rname, snippet: rsnip };
  }
  // Optional mentions list
  let mentions: string[] | undefined;
  if (Array.isArray(body?.mentions)) {
    const cleaned = body.mentions
      .map((x: any) => String(x || '').toLowerCase().slice(0, 80))
      .filter((x: string) => x.length > 0)
      .slice(0, 25);
    if (cleaned.length > 0) mentions = cleaned;
  }
  // Optional DM target (private message)
  let toUserId: string | undefined;
  if (typeof body?.toUserId === 'string' && body.toUserId.trim()) {
    toUserId = body.toUserId.slice(0, 80);
  }

  const u = await currentUser();
  const name = u?.firstName || u?.username || (u?.emailAddresses?.[0]?.emailAddress?.split("@")[0]) || "Guest";

  const msg: ChatMessage = {
    id: rid(),
    userId,
    name: String(name).slice(0, 80),
    text,
    ts: new Date().toISOString(),
    ...(replyTo ? { replyTo } : {}),
    ...(mentions ? { mentions } : {}),
    ...(toUserId ? { toUserId } : {}),
  };

  try {
    const saved = await chatStore.append(ev.id, msg);
    return NextResponse.json({ message: saved });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "append_failed" }, { status: 400 });
  }
}


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

function rid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const ev = await eventStore.byId(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const messages = await chatStore.list(ev.id);
  return NextResponse.json({ messages });
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ev = await eventStore.byId(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch {}
  const text = String(body?.text || "").trim();
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });

  const u = await currentUser();
  const name = u?.firstName || u?.username || (u?.emailAddresses?.[0]?.emailAddress?.split("@")[0]) || "Guest";

  const msg: ChatMessage = {
    id: rid(),
    userId,
    name: String(name).slice(0, 80),
    text,
    ts: new Date().toISOString(),
  };

  try {
    const saved = await chatStore.append(ev.id, msg);
    return NextResponse.json({ message: saved });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "append_failed" }, { status: 400 });
  }
}


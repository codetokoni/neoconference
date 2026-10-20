// src/app/api/events/[id]/chat/route.ts
//
// GET  -> recent chat (public if event is public)
// POST -> append message (must be authenticated)
//
// A visitor in a partner's widget (/embed/zone) has no account: their
// signed embed session stands in, for their own meeting's chat only, and
// they post under the name the partner gave them.

import { errorMessage } from "@/lib/errorMessage";
import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { chatStore } from '@/lib/chatStore';
import { embedCaller } from '@/lib/partners/embedCaller';
import { hitRateLimit } from '@/lib/support/tickets';
import type { ChatMessage, ChatAttachment } from '@/types/event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


async function findEvent(idOrSlugOrRoom: string) {
  let ev = await eventStore.byId(idOrSlugOrRoom);
  if (ev) return ev;
  ev = await eventStore.bySlug(idOrSlugOrRoom);
  if (ev) return ev;
  try {
    const all = await eventStore.listAll();
    return all.find((e) => e.livekitRoom === idOrSlugOrRoom) || null;
  } catch { return null; }
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  const embed = userId ? null : await embedCaller(req);
  if (!userId && !embed) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (embed && !(await hitRateLimit(`chat-read:embed:${embed.identity}`, 60, 60)).ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const ev = await findEvent(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (embed && ev.id !== embed.eventId) return NextResponse.json({ error: "wrong_room" }, { status: 403 });
  let messages = await chatStore.list(ev.id);
  // Private messages only to the two people in them.
  if (embed) messages = messages.filter((m) => !m.toUserId || m.toUserId === embed.identity || m.userId === embed.identity);
  return NextResponse.json({ messages });
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  const embed = userId ? null : await embedCaller(req);
  if (!userId && !embed) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (embed && !(await hitRateLimit(`chat:embed:${embed.identity}`, 20, 60)).ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const ev = await findEvent(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (embed && ev.id !== embed.eventId) return NextResponse.json({ error: "wrong_room" }, { status: 403 });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const text = String(body?.text || "").trim();
  // Attachments — parsed here so an attachment-only message ("no
  // words, just the file") passes the empty-text gate. chatStore
  // re-sanitizes on append, so any shape the client sent that
  // doesn't match ChatAttachment is silently dropped there.
  let attachments: ChatAttachment[] | undefined;
  // Uploading needs an account, so an embed visitor has no file of ours to
  // attach: anything they send is a link they made up.
  if (!embed && Array.isArray(body?.attachments) && body.attachments.length > 0) {
    attachments = body.attachments as ChatAttachment[];
  }
  if (!text && (!attachments || attachments.length === 0)) {
    return NextResponse.json({ error: "empty" }, { status: 400 });
  }
  // Optional reply context
  let replyTo: { id: string; name: string; snippet: string } | undefined;
  if (body?.replyTo && typeof body.replyTo === 'object') {
    const reply = body.replyTo as Record<string, unknown>;
    const rid = String(reply.id || '').slice(0, 64);
    const rname = String(reply.name || '').slice(0, 80);
    const rsnip = String(reply.snippet || '').slice(0, 140);
    if (rid && rname) replyTo = { id: rid, name: rname, snippet: rsnip };
  }
  // Optional mentions list
  let mentions: string[] | undefined;
  if (Array.isArray(body?.mentions)) {
    const cleaned = body.mentions
      .map((x: unknown) => String(x || '').toLowerCase().slice(0, 80))
      .filter((x: string) => x.length > 0)
      .slice(0, 25);
    if (cleaned.length > 0) mentions = cleaned;
  }
  // Optional DM target (private message)
  let toUserId: string | undefined;
  if (!embed && typeof body?.toUserId === 'string' && body.toUserId.trim()) {
    toUserId = body.toUserId.slice(0, 80);
  }

  let name: string;
  if (embed) {
    name = embed.name;
  } else {
    const u = await currentUser();
    name = u?.firstName || u?.username || (u?.emailAddresses?.[0]?.emailAddress?.split("@")[0]) || "Guest";
  }

  const msg: ChatMessage = {
    id: rid(),
    // An embed visitor is their room identity, as everyone in the room sees them.
    userId: userId || embed?.identity || "",
    name: String(name).slice(0, 80),
    text,
    ts: new Date().toISOString(),
    ...(replyTo ? { replyTo } : {}),
    ...(mentions ? { mentions } : {}),
    ...(toUserId ? { toUserId } : {}),
    ...(attachments ? { attachments } : {}),
  };

  try {
    const saved = await chatStore.append(ev.id, msg);
    return NextResponse.json({ message: saved });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) || "append_failed" }, { status: 400 });
  }
}


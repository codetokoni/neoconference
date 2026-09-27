// src/app/api/events/[id]/summary/route.ts
//
// Owner-only AI meeting summary endpoint.
// GET  - returns existing summary (or null) without recomputing.
// POST - generates a fresh summary by sending transcript + chat to OpenAI.

import { errorMessage } from "@/lib/errorMessage";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { assertOwnerOrAdmin } from "@/lib/roles";
import { chatStore } from "@/lib/chatStore";
import { eventTranscripts } from "@/lib/eventRecordings";
import { summaryContext } from "@/lib/meetingSummary";
import { isR2Configured } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ev = await eventStore.byId(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const checkGet = await assertOwnerOrAdmin(ev, userId);
  if (!checkGet.ok) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, summary: ev.summary || null });
}

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ev = await eventStore.byId(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const checkPost = await assertOwnerOrAdmin(ev, userId);
  if (!checkPost.ok) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "openai_not_configured", hint: "Set OPENAI_API_KEY in env" }, { status: 503 });
  }

  const chat = await chatStore.list(ev.id).catch(() => []);
  // Transcripts are indexed by recording, not by meeting; reach them through
  // the meeting's recordings. No storage configured means no recordings.
  const transcripts = isR2Configured()
    ? await eventTranscripts(ev).catch(() => [])
    : [];
  const context = summaryContext(ev, chat, transcripts);

  if (context.trim().length < 50) {
    return NextResponse.json({ error: "no_content", hint: "No transcript or chat to summarize yet" }, { status: 422 });
  }

  let summaryText = "";
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a concise meeting summarizer. Given a transcript and chat, produce: (1) a 2-3 sentence overview, (2) up to 5 key decisions, (3) up to 5 action items. Output as Markdown with H3 section headers. Be terse.",
          },
          { role: "user", content: context },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => "");
      return NextResponse.json({ error: "openai_failed", status: r.status, detail: errBody.slice(0, 400) }, { status: 502 });
    }
    const j = await r.json();
    summaryText = j?.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    return NextResponse.json({ error: "openai_error", detail: errorMessage(e) || "unknown" }, { status: 502 });
  }

  if (!summaryText) {
    return NextResponse.json({ error: "empty_summary" }, { status: 502 });
  }

  const summary = { text: summaryText, model: OPENAI_MODEL, generatedAt: Date.now() };
  await eventStore.update(ev.id, { summary });
  return NextResponse.json({ ok: true, summary });
}

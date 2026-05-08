// src/app/api/events/[id]/summary/route.ts
//
// Owner-only AI meeting summary endpoint.
// GET  - returns existing summary (or null) without recomputing.
// POST - generates a fresh summary by sending transcript + chat to OpenAI.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { chatStore } from "@/lib/chatStore";
import { transcribeStore } from "@/lib/transcribeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";
const MAX_INPUT_CHARS = 60000;

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ev = await eventStore.byId(params.id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (ev.ownerUserId !== userId) {
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
  if (ev.ownerUserId !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "openai_not_configured", hint: "Set OPENAI_API_KEY in env" }, { status: 503 });
  }

  const chat = await chatStore.list(ev.id, 1000).catch(() => [] as any[]);
  const transcripts = await transcribeStore.get(ev.id).catch(() => null);

  const chatLines = (Array.isArray(chat) ? chat : [])
    .map((m: any) => (m.from?.name || m.from?.identity || "guest") + ": " + (m.message || ""))
    .join("\n");

  const transcriptText = transcripts && typeof (transcripts as any).text === "string" ? (transcripts as any).text : "";

  let context = "EVENT: " + (ev.name || ev.slug) + "\n";
  if (ev.description) context += "DESCRIPTION: " + ev.description + "\n";
  if (transcriptText) context += "\nTRANSCRIPT:\n" + transcriptText + "\n";
  if (chatLines) context += "\nCHAT:\n" + chatLines + "\n";
  if (context.length > MAX_INPUT_CHARS) context = context.slice(0, MAX_INPUT_CHARS);

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
  } catch (e: any) {
    return NextResponse.json({ error: "openai_error", detail: e?.message || "unknown" }, { status: 502 });
  }

  if (!summaryText) {
    return NextResponse.json({ error: "empty_summary" }, { status: 502 });
  }

  const summary = { text: summaryText, model: OPENAI_MODEL, generatedAt: Date.now() };
  await eventStore.update(ev.id, { summary } as any);
  return NextResponse.json({ ok: true, summary });
}

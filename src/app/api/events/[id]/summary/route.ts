// src/app/api/events/[id]/summary/route.ts
//
// Owner-only AI meeting summary endpoint.
// GET  - returns existing summary (or null) without recomputing.
// POST - generates a fresh summary from transcript + chat (src/lib/llm.ts:
//        Vercel AI Gateway by default, OpenAI directly if a key is set).

import { NextResponse } from "next/server";
import { aiAvailable, chatCompletion } from "@/lib/llm";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { assertOwnerOrAdmin } from "@/lib/roles";
import { chatStore } from "@/lib/chatStore";
import { eventTranscripts } from "@/lib/eventRecordings";
import { SUMMARY_INSTRUCTIONS, plainSummary, summaryContext } from "@/lib/meetingSummary";
import { isR2Configured } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";

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

  if (!aiAvailable()) {
    return NextResponse.json(
      { error: "ai_not_configured", hint: "Runs through Vercel AI Gateway on Vercel; elsewhere set AI_GATEWAY_API_KEY or OPENAI_API_KEY" },
      { status: 503 }
    );
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

  const result = await chatCompletion({
    model: SUMMARY_MODEL,
    system: SUMMARY_INSTRUCTIONS,
    user: context,
    temperature: 0.3,
    maxTokens: 800,
  });
  if (!result.ok) {
    if (result.error === "ai_not_configured") {
      return NextResponse.json({ error: "ai_not_configured" }, { status: 503 });
    }
    console.warn("[summary] AI call failed", { eventId: ev.id, status: result.status, detail: result.detail });
    return NextResponse.json({ error: "ai_failed", status: result.status, detail: result.detail }, { status: 502 });
  }
  if (!result.text) {
    return NextResponse.json({ error: "empty_summary" }, { status: 502 });
  }

  const summary = { text: plainSummary(result.text), model: result.model, generatedAt: Date.now() };
  await eventStore.update(ev.id, { summary });
  return NextResponse.json({ ok: true, summary });
}

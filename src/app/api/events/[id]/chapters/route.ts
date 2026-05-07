// src/app/api/events/[id]/chapters/route.ts
//
// Owner-only: derive (or re-derive) chapter markers for an event from its
// most recent transcript artifact (event.recordings where kind=transcript).
// Uses gpt-4o-mini when OPENAI_API_KEY is set, falls back to a local heuristic.
//
// POST /api/events/<id>/chapters
//   body: { mode?: "auto" | "ai" | "heuristic", durationSec?: number, text?: string }
//   - mode "auto" (default): tries AI then falls back to heuristic.
//   - mode "heuristic": forces local derivation, never calls OpenAI.
//   - mode "ai": forces AI; returns 422 if OPENAI_API_KEY missing.
//   - text: optional override transcript body. If omitted, the latest
//           transcript artifact on the event is used.
//   returns: { chapters, source }
//
// PUT /api/events/<id>/chapters
//   body: { chapters: Chapter[] }
//   - manual override; persists exactly what the host edited.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eventStore } from '@/lib/eventStore';
import { deriveChaptersHeuristic, deriveChaptersWithAI } from '@/lib/chapters';
import type { Chapter, NeoEvent } from '@/types/event';

export const runtime = 'nodejs';

function latestTranscriptText(ev: NeoEvent): string {
  const transcripts = (ev.recordings || []).filter((r) => r.kind === 'transcript' && r.label);
  if (transcripts.length === 0) return '';
  const sorted = [...transcripts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return sorted[0].label || '';
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const ev = await eventStore.get(id);
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (ev.ownerUserId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const mode: 'auto' | 'ai' | 'heuristic' = body?.mode === 'ai' || body?.mode === 'heuristic' ? body.mode : 'auto';
  const durationSec = typeof body?.durationSec === 'number' && body.durationSec > 0 ? body.durationSec : undefined;

  const text = (body?.text && typeof body.text === 'string' && body.text.trim())
    ? body.text
    : latestTranscriptText(ev);

  if (!text || !text.trim()) {
    return NextResponse.json({ error: 'no_transcript', message: 'No transcript text available. Run transcription first.' }, { status: 422 });
  }

  let chapters: Chapter[] = [];
  let source: 'ai' | 'heuristic' = 'heuristic';

  if (mode === 'ai') {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'ai_unavailable', message: 'OPENAI_API_KEY not configured' }, { status: 422 });
    }
    chapters = await deriveChaptersWithAI({ text, durationSec });
    source = chapters.some((c) => c.source === 'ai') ? 'ai' : 'heuristic';
  } else if (mode === 'heuristic') {
    chapters = deriveChaptersHeuristic({ text, durationSec });
    source = 'heuristic';
  } else {
    chapters = await deriveChaptersWithAI({ text, durationSec });
    source = chapters.some((c) => c.source === 'ai') ? 'ai' : 'heuristic';
  }

  await eventStore.update(ev.id, { chapters });
  return NextResponse.json({ chapters, source });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const ev = await eventStore.get(id);
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (ev.ownerUserId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body?.chapters)) {
    return NextResponse.json({ error: 'invalid_body', message: 'chapters must be an array' }, { status: 400 });
  }
  const cleaned: Chapter[] = body.chapters
    .map((c: unknown, i: number) => {
      const x = c as { id?: string; startSec?: number; endSec?: number; label?: string; summary?: string };
      const startSec = typeof x.startSec === 'number' ? Math.max(0, Math.floor(x.startSec)) : 0;
      const endSec = typeof x.endSec === 'number' && x.endSec > startSec ? Math.floor(x.endSec) : undefined;
      const label = (x.label || '').toString().slice(0, 80).trim();
      if (!label) return null;
      return {
        id: x.id || ('manual-' + (i + 1)),
        startSec,
        endSec,
        label,
        summary: x.summary ? x.summary.toString().slice(0, 240) : undefined,
        source: 'manual' as const,
      } as Chapter;
    })
    .filter((c: Chapter | null): c is Chapter => c !== null)
    .sort((a: Chapter, b: Chapter) => a.startSec - b.startSec);

  await eventStore.update(ev.id, { chapters: cleaned });
  return NextResponse.json({ chapters: cleaned });
}


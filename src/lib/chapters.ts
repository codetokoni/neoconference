// src/lib/chapters.ts
//
// Chapter derivation utilities. Two strategies:
//
//   1. deriveChaptersHeuristic(text, durationSec) - free, instant.
//      Splits the transcript into N evenly-spaced segments and picks the
//      first salient sentence of each segment as the label. Always works,
//      even when no AI key is configured.
//
//   2. deriveChaptersWithAI(text, durationSec) - uses OpenAI gpt-4o-mini
//      to produce 4-8 cinematic chapter titles + 1-sentence summaries.
//      Falls back to heuristic when OPENAI_API_KEY is missing.
//
// Both return Chapter[] in the schema defined in src/types/event.ts.

import type { Chapter } from '@/types/event';

/** Approximate words-per-second for English speech. Used to map word offsets
 *  back to seconds when we only have a flat transcript with no per-word timing. */
const WORDS_PER_SEC = 2.5;

function slugifyLabel(label: string, idx: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base ? base + '-' + idx : 'chapter-' + idx;
}

function splitSentences(text: string): string[] {
  // Lightweight sentence splitter: . ? ! followed by space + capital, or newline.
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'\u201c])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Pick the most "headline-like" sentence from a slice: shortest sentence
 *  >= 4 words and <= 14 words, falling back to the first one. */
function pickHeadline(sentences: string[]): string {
  const candidates = sentences
    .map((s) => ({ s, w: s.split(/\s+/).length }))
    .filter((x) => x.w >= 4 && x.w <= 14)
    .sort((a, b) => a.w - b.w);
  const pick = candidates[0]?.s || sentences[0] || '';
  // Strip trailing punctuation and trim to 60 chars for clean display.
  return pick.replace(/[.!?]+$/, '').slice(0, 60).trim();
}

/**
 * Heuristic derivation. Splits transcript into ~6 evenly-timed segments and
 * extracts a headline from each. Always succeeds, even with no AI key.
 */
export function deriveChaptersHeuristic(input: {
  text: string;
  durationSec?: number;
  targetCount?: number;
}): Chapter[] {
  const text = (input.text || '').trim();
  if (!text) return [];
  const target = Math.max(2, Math.min(12, input.targetCount ?? 6));
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const totalWords = text.split(/\s+/).length;
  const durationSec = input.durationSec && input.durationSec > 0
    ? input.durationSec
    : totalWords / WORDS_PER_SEC;

  const segCount = Math.max(2, Math.min(target, Math.floor(sentences.length / 2)));
  const sentencesPerSeg = Math.ceil(sentences.length / segCount);
  const secPerSeg = durationSec / segCount;

  const out: Chapter[] = [];
  for (let i = 0; i < segCount; i++) {
    const slice = sentences.slice(i * sentencesPerSeg, (i + 1) * sentencesPerSeg);
    if (slice.length === 0) continue;
    const label = pickHeadline(slice) || ('Section ' + (i + 1));
    const startSec = Math.round(i * secPerSeg);
    const endSec = Math.round((i + 1) * secPerSeg);
    out.push({
      id: slugifyLabel(label, i + 1),
      startSec,
      endSec,
      label,
      summary: slice[0]?.slice(0, 140),
      source: 'heuristic',
    });
  }
  return out;
}

/**
 * AI derivation. Asks gpt-4o-mini for 4-8 cinematic chapter titles + summaries.
 * Returns heuristic chapters when OPENAI_API_KEY is missing or the call fails.
 */
export async function deriveChaptersWithAI(input: {
  text: string;
  durationSec?: number;
}): Promise<Chapter[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  const fallback = () => deriveChaptersHeuristic({ text: input.text, durationSec: input.durationSec });
  if (!apiKey) return fallback();
  const text = (input.text || '').trim();
  if (!text) return [];

  // Cap input to ~12k chars to stay well under context for gpt-4o-mini.
  const trimmed = text.length > 12000 ? text.slice(0, 12000) + '...' : text;
  const durationSec = input.durationSec && input.durationSec > 0
    ? input.durationSec
    : (text.split(/\s+/).length / WORDS_PER_SEC);

  const sys = 'You are a senior video producer. Given a transcript of a meeting or talk, produce 4-8 chapter markers.' +
    ' Return STRICT JSON only (no markdown fences) of shape: {"chapters":[{"label":"...","summary":"...","startFraction":0.0}]}' +
    ' where startFraction is between 0 and 1 representing where the chapter begins in the transcript.' +
    ' Labels must be 2-6 words, punchy, and human. Summaries must be a single sentence.';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: trimmed },
        ],
      }),
    });
    if (!res.ok) return fallback();
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    let parsed: { chapters?: Array<{ label?: string; summary?: string; startFraction?: number }> } = {};
    try { parsed = JSON.parse(raw); } catch { return fallback(); }
    const arr = Array.isArray(parsed.chapters) ? parsed.chapters : [];
    if (arr.length === 0) return fallback();
    const sorted = arr
      .map((c, i) => ({
        label: (c.label || '').toString().slice(0, 60).trim() || ('Chapter ' + (i + 1)),
        summary: (c.summary || '').toString().slice(0, 200).trim(),
        startFraction: typeof c.startFraction === 'number' ? Math.max(0, Math.min(1, c.startFraction)) : i / arr.length,
      }))
      .sort((a, b) => a.startFraction - b.startFraction);
    const out: Chapter[] = sorted.map((c, i) => {
      const startSec = Math.round(c.startFraction * durationSec);
      const next = sorted[i + 1];
      const endSec = next ? Math.round(next.startFraction * durationSec) : Math.round(durationSec);
      return {
        id: slugifyLabel(c.label, i + 1),
        startSec,
        endSec,
        label: c.label,
        summary: c.summary || undefined,
        source: 'ai' as const,
      };
    });
    return out.length > 0 ? out : fallback();
  } catch {
    return fallback();
  }
}

/** Format seconds as 1:23 or 1:02:34. */
export function formatChapterTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
  if (h > 0) return h + ':' + pad(m) + ':' + pad(r);
  return m + ':' + pad(r);
}


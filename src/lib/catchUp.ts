import { kv } from "@/lib/kv";
import { chatCompletion } from "@/lib/llm";
import { channelsForRoom, machineChannelsForRoom } from "@/lib/simulcast";
import { TRANSLATION_LANGUAGES } from "@/lib/translationLanguages";

/**
 * "What did I miss?" — a short summary of the programme so far, in the
 * viewer's language, from the source transcript the translation worker
 * keeps for the room.
 *
 * One summary per room and language is shared by every viewer and made at
 * most once every REFRESH_MS, so thousands of viewers cost one AI call per
 * language every couple of minutes, not one each.
 */

export const REFRESH_MS = 2 * 60 * 1000;
/** A silence longer than this separates one programme from the last. */
export const SESSION_GAP_MS = 20 * 60 * 1000;
/** The most transcript sent to the model: the latest part when longer. */
const MAX_CHARS = 60_000;

export interface TranscriptLine {
  text: string;
  original?: string;
  ts: number;
  seq: number;
}

export interface CatchUp {
  lang: string;
  summary: string;
  points: string[];
  /** Minutes of programme the summary covers. */
  minutes: number;
  /** When it was made (ms). */
  at: number;
  /** Seq of the last transcript line it includes. */
  upTo: number;
}

/** The languages a room offers: the floor, the booths and the captions. */
export function roomLanguages(room: string): Set<string> {
  return new Set([...channelsForRoom(room), ...machineChannelsForRoom(room)].map((c) => c.lang));
}

export function languageName(lang: string): string {
  const known = TRANSLATION_LANGUAGES.find((l) => l.code === lang);
  if (known) return known.label;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

/**
 * The lines of the programme now going on: from the end back to the last
 * silence longer than SESSION_GAP_MS. Empty when nothing was said in that
 * long — the programme has not started, or it is over.
 */
export function currentSession(lines: TranscriptLine[], now: number): TranscriptLine[] {
  const sorted = lines.filter((l) => (l.original ?? l.text)?.trim()).sort((a, b) => a.seq - b.seq);
  if (!sorted.length || now - sorted[sorted.length - 1].ts > SESSION_GAP_MS) return [];
  let start = sorted.length - 1;
  while (start > 0 && sorted[start].ts - sorted[start - 1].ts <= SESSION_GAP_MS) start--;
  return sorted.slice(start);
}

const cacheKey = (room: string, lang: string) => `neo:video:catchup:${room}:${lang}`;
const lockKey = (room: string, lang: string) => `neo:video:catchup:lock:${room}:${lang}`;

export async function cachedCatchUp(room: string, lang: string): Promise<CatchUp | null> {
  const raw = await kv.get<CatchUp | string>(cacheKey(room, lang));
  if (!raw) return null;
  return typeof raw === "string" ? (JSON.parse(raw) as CatchUp) : raw;
}

export type CatchUpResult =
  | { status: "ready"; catchUp: CatchUp; fresh: boolean }
  | { status: "nothing_yet" }
  | { status: "busy" }
  | { status: "failed" };

/**
 * The summary for this room and language: the shared one when it is recent
 * (or nothing new was said since), otherwise a new one. While another
 * request is making it, the previous one is returned, or "busy".
 */
export async function getCatchUp(
  room: string,
  lang: string,
  fetchTranscript: () => Promise<TranscriptLine[]>,
  now = Date.now(),
): Promise<CatchUpResult> {
  const cached = await cachedCatchUp(room, lang);
  if (cached && now - cached.at < REFRESH_MS) return { status: "ready", catchUp: cached, fresh: false };

  const won = await kv.set(lockKey(room, lang), 1, { nx: true, ex: 45 });
  if (!won) return cached ? { status: "ready", catchUp: cached, fresh: false } : { status: "busy" };

  try {
    const session = currentSession(await fetchTranscript(), now);
    if (!session.length) return { status: "nothing_yet" };
    const last = session[session.length - 1];
    if (cached && cached.upTo === last.seq) {
      // Nothing new was said: keep the summary, just mark it checked.
      const kept = { ...cached, at: now };
      await kv.set(cacheKey(room, lang), JSON.stringify(kept), { ex: 6 * 60 * 60 });
      return { status: "ready", catchUp: kept, fresh: false };
    }

    let text = session.map((l) => (l.original ?? l.text).trim()).join("\n");
    const trimmed = text.length > MAX_CHARS;
    if (trimmed) text = text.slice(text.length - MAX_CHARS);
    const minutes = Math.max(1, Math.round((last.ts - session[0].ts) / 60000));
    const name = languageName(lang);

    const r = await chatCompletion({
      model: "gpt-4o-mini",
      json: true,
      temperature: 0.2,
      maxTokens: 700,
      system:
        `You help someone who joined a live programme late catch up. You are given the live ` +
        `transcript so far (speech-to-text, so expect small errors). Write in ${name} only. ` +
        `Reply as JSON: {"summary": string, "points": string[]}. "summary": 2-4 plain sentences ` +
        `on what has happened so far, most important first. "points": 3-6 short key points, ` +
        `including any instruction given to the audience. Keep names, scripture references and ` +
        `numbers exactly. Never invent anything not in the transcript.`,
      user:
        `Programme so far (${minutes} minutes${trimmed ? ", the latest part only" : ""}):\n\n${text}`,
    });
    if (!r.ok) return cached ? { status: "ready", catchUp: cached, fresh: false } : { status: "failed" };

    let parsed: { summary?: unknown; points?: unknown };
    try {
      parsed = JSON.parse(r.text);
    } catch {
      return cached ? { status: "ready", catchUp: cached, fresh: false } : { status: "failed" };
    }
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 1200) : "";
    const points = Array.isArray(parsed.points)
      ? parsed.points.filter((p): p is string => typeof p === "string").map((p) => p.trim().slice(0, 300)).filter(Boolean).slice(0, 6)
      : [];
    if (!summary) return cached ? { status: "ready", catchUp: cached, fresh: false } : { status: "failed" };

    const catchUp: CatchUp = { lang, summary, points, minutes, at: now, upTo: last.seq };
    await kv.set(cacheKey(room, lang), JSON.stringify(catchUp), { ex: 6 * 60 * 60 });
    return { status: "ready", catchUp, fresh: true };
  } finally {
    await kv.del(lockKey(room, lang)).catch(() => {});
  }
}

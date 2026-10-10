// src/lib/voiceProfiles.ts
//
// Cloned speaker voices for meeting translation: who has one, the consent
// behind it, and the shared, capped generation of translated sentences.
//
//   neo:voice:profile:<userId>      VoiceProfile (JSON)
//   neo:voice:profiles              set of userIds with a profile
//   neo:voice:clip:<sha256>         a generated sentence (base64 MP3), 15 min
//   neo:voice:usage:<room>:<day>    characters spoken in that meeting that day
//   neo:voice:usage:month:<yyyy-mm> characters spoken across all meetings
//
// A listener asks for one translated sentence in the speaker's voice. Every
// listener of that sentence in that language gets the same clip: it is made
// once (a lock stops a crowd making it twice) and kept for 15 minutes. A
// meeting has a daily character cap; past it, and whenever anything fails,
// the listener's page falls back to its own computer voice.

import { createHash } from "node:crypto";
import { kv } from "@/lib/kv";
import { CARTESIA_LANGUAGES, cartesiaConfigured, speakInVoice } from "@/lib/cartesia";

export interface VoiceConsent {
  /** Who gave consent, as they named themselves. */
  by: string;
  /** When they gave it (ms), as recorded by the admin. */
  at: number;
  /** The words they agreed to. */
  statement: string;
}

export interface VoiceProfile {
  userId: string;
  /** How the speaker is shown, e.g. "Pastor Chris". */
  name: string;
  voiceId: string;
  /** The language of the recording the voice was made from. */
  sampleLanguage: string;
  enabled: boolean;
  consent: VoiceConsent;
  createdAt: number;
  createdBy: string;
}

export const CLIP_TTL_SECONDS = 15 * 60;
export const MAX_SENTENCE_CHARS = 500;

const profileKey = (userId: string) => `neo:voice:profile:${userId}`;
const PROFILES = "neo:voice:profiles";
const clipKey = (hash: string) => `neo:voice:clip:${hash}`;
const lockKey = (hash: string) => `neo:voice:lock:${hash}`;
const dayKey = (room: string, day: string) => `neo:voice:usage:${room}:${day}`;
const monthKey = (month: string) => `neo:voice:usage:month:${month}`;

export function dailyCharCap(): number {
  const n = Number(process.env.VOICE_ROOM_DAILY_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

function parse<T>(raw: unknown): T | null {
  if (!raw) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

export async function getVoiceProfile(userId: string): Promise<VoiceProfile | null> {
  return parse<VoiceProfile>(await kv.get(profileKey(userId)));
}

export async function listVoiceProfiles(): Promise<VoiceProfile[]> {
  const ids = ((await kv.smembers(PROFILES)) ?? []) as string[];
  const all = await Promise.all(ids.map(getVoiceProfile));
  return all.filter((p): p is VoiceProfile => Boolean(p)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveVoiceProfile(p: VoiceProfile): Promise<void> {
  await kv.set(profileKey(p.userId), JSON.stringify(p));
  await kv.sadd(PROFILES, p.userId);
}

export async function removeVoiceProfile(userId: string): Promise<void> {
  await kv.del(profileKey(userId));
  await kv.srem(PROFILES, userId);
}

/** The NeoConference user behind a LiveKit identity ("<clerkUserId>#<nonce>"). */
export function userIdOfIdentity(identity: string): string {
  return String(identity ?? "").split("#")[0].trim();
}

export type SpeakResult =
  | { status: "ok"; mp3: Buffer; cached: boolean }
  | { status: "no_voice" | "language" | "capped" | "not_configured" | "busy" | "failed" };

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * One translated sentence in the speaker's cloned voice. The clip is shared
 * by everyone asking for the same voice, language and words.
 */
export async function voiceClip(input: {
  room: string;
  identity: string;
  lang: string;
  text: string;
  now?: number;
}): Promise<SpeakResult> {
  const now = input.now ?? Date.now();
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, MAX_SENTENCE_CHARS);
  const lang = input.lang.toLowerCase();
  if (!text) return { status: "failed" };
  if (!CARTESIA_LANGUAGES.has(lang)) return { status: "language" };

  const profile = await getVoiceProfile(userIdOfIdentity(input.identity));
  if (!profile || !profile.enabled) return { status: "no_voice" };
  if (!cartesiaConfigured()) return { status: "not_configured" };

  const hash = createHash("sha256").update(`${profile.voiceId}\n${lang}\n${text}`).digest("hex");
  const hit = await kv.get<string>(clipKey(hash));
  if (hit) return { status: "ok", mp3: Buffer.from(hit, "base64"), cached: true };

  // Someone else is making this very clip: wait for it rather than pay twice.
  const won = await kv.set(lockKey(hash), 1, { nx: true, ex: 20 });
  if (!won) {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const later = await kv.get<string>(clipKey(hash));
      if (later) return { status: "ok", mp3: Buffer.from(later, "base64"), cached: true };
    }
    return { status: "busy" };
  }

  try {
    const used = Number((await kv.get(dayKey(input.room, today(now)))) ?? 0);
    if (used + text.length > dailyCharCap()) return { status: "capped" };

    const r = await speakInVoice(text, profile.voiceId, lang);
    if (!r.ok) {
      console.warn("[voice] cartesia speak failed", r.status, r.detail);
      return { status: "failed" };
    }
    const mp3 = Buffer.from(r.value);
    await kv.set(clipKey(hash), mp3.toString("base64"), { ex: CLIP_TTL_SECONDS });
    await kv.incrby(dayKey(input.room, today(now)), text.length);
    await kv.expire(dayKey(input.room, today(now)), 3 * 24 * 60 * 60);
    await kv.incrby(monthKey(today(now).slice(0, 7)), text.length);
    return { status: "ok", mp3, cached: false };
  } finally {
    await kv.del(lockKey(hash)).catch(() => {});
  }
}

export async function monthlyChars(month: string): Promise<number> {
  return Number((await kv.get(monthKey(month))) ?? 0);
}

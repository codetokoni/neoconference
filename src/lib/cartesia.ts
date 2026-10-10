// src/lib/cartesia.ts
//
// Cartesia: cloned speaker voices for meeting translation. Two calls only:
// make a voice from a recording, and speak a sentence in it. The key is
// CARTESIA_API_KEY (server only); the model defaults to sonic-3.6.
// API: https://docs.cartesia.ai/api-reference (version header 2026-08-14).

const BASE = "https://api.cartesia.ai";
const VERSION = "2026-08-14";

/** Languages sonic-3.6 speaks that meetings can translate into. No Swahili. */
export const CARTESIA_LANGUAGES = new Set([
  "en", "fr", "de", "es", "pt", "zh", "ja", "hi", "it", "ko", "nl", "pl", "ru", "sv", "tr", "tl", "bg", "ro",
  "ar", "cs", "el", "fi", "hr", "ms", "sk", "da", "ta", "uk", "hu", "no", "vi", "bn", "th", "he", "ka", "id",
  "te", "gu", "kn", "ml", "mr", "pa", "or", "ur",
]);

export function cartesiaConfigured(): boolean {
  return Boolean(process.env.CARTESIA_API_KEY?.trim());
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.CARTESIA_API_KEY?.trim() ?? ""}`,
    "Cartesia-Version": VERSION,
    ...extra,
  };
}

export type CartesiaResult<T> = { ok: true; value: T } | { ok: false; status: number; detail: string };

/** Make a cloned voice from a recording (≤ 16 MB; wav, mp3, ogg, webm, flac). */
export async function cloneVoice(clip: Blob, filename: string, name: string, language: string): Promise<CartesiaResult<string>> {
  const form = new FormData();
  form.append("clip", clip, filename);
  form.append("name", name.slice(0, 100));
  form.append("language", language);
  form.append("description", "NeoConference meeting translation voice");
  try {
    const res = await fetch(`${BASE}/voices/clone`, {
      method: "POST",
      headers: headers(),
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 400) };
    const j = (await res.json()) as { id?: string };
    return j.id ? { ok: true, value: j.id } : { ok: false, status: 502, detail: "No voice id in the reply." };
  } catch (e) {
    return { ok: false, status: 0, detail: (e as Error).message };
  }
}

export async function deleteVoice(voiceId: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/voices/${encodeURIComponent(voiceId)}`, {
      method: "DELETE",
      headers: headers(),
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** One sentence in a cloned voice, as MP3 bytes. */
export async function speakInVoice(text: string, voiceId: string, language: string): Promise<CartesiaResult<ArrayBuffer>> {
  try {
    const res = await fetch(`${BASE}/tts/bytes`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model_id: process.env.CARTESIA_MODEL?.trim() || "sonic-3.6",
        transcript: text,
        voice: { id: voiceId },
        language,
        output_format: { container: "mp3", sample_rate: 24000, bit_rate: 64000 },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 400) };
    return { ok: true, value: await res.arrayBuffer() };
  } catch (e) {
    return { ok: false, status: 0, detail: (e as Error).message };
  }
}

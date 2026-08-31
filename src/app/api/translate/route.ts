// src/app/api/translate/route.ts
//
// POST /api/translate
// Body: { text: string, targetLang: string, sourceLang?: string }
// Response on success: 200 { translated: string, sourceLang?: string }
// Response on missing key: 503 { error: "translation_not_configured" }
// Response on bad input: 400 { error: string }
//
// Thin proxy to DeepL. Kept out of the browser so DEEPL_API_KEY never
// leaves the server. Called per-final-caption by the LiveTranslation
// client component (see src/components/LiveTranslation.tsx).
//
// Language codes come from src/lib/locales.ts (BCP-47 short tags —
// "en", "es", "fr" etc). DeepL wants uppercase target codes and a
// handful of remapping cases (e.g. "en" -> "EN-US"). See toDeeplCode().
//
// No streaming — DeepL returns fast enough on short caption strings
// (~150-400ms) and streaming would add complexity without user-
// visible benefit for one-sentence utterances.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Codes DeepL accepts as `target_lang`. See
// https://developers.deepl.com/docs/resources/supported-languages
// (subset — mirrors src/lib/locales.ts).
const TARGET_LANG_MAP: Record<string, string> = {
  en: "EN-US",
  es: "ES",
  fr: "FR",
  de: "DE",
  pt: "PT-PT",
  it: "IT",
  nl: "NL",
  ja: "JA",
  ko: "KO",
  zh: "ZH",
  ru: "RU",
  tr: "TR",
  pl: "PL",
  // ar / hi have no official DeepL support at the time of writing —
  // return not_supported for those rather than silently falling back.
};

function toDeeplCode(code: string): string | null {
  if (!code) return null;
  const short = code.trim().toLowerCase().split("-")[0];
  return TARGET_LANG_MAP[short] ?? null;
}

interface Body {
  text?: unknown;
  targetLang?: unknown;
  sourceLang?: unknown;
}

const bad = (code: string, status = 400) =>
  NextResponse.json({ error: code }, { status });

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return bad("unauthenticated", 401);

  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) return bad("translation_not_configured", 503);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return bad("invalid_json");
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const targetShort = typeof body.targetLang === "string" ? body.targetLang : "";
  const sourceShort = typeof body.sourceLang === "string" ? body.sourceLang : "";
  if (!text) return bad("missing_text");
  const target = toDeeplCode(targetShort);
  if (!target) return bad("target_not_supported");

  // Hard cap per call — a single caption should never be longer than
  // this. Prevents abuse of the endpoint as a general translator.
  if (text.length > 2000) return bad("text_too_long");

  // DeepL's free tier uses api-free.deepl.com; paid tier uses api.deepl.com.
  // Free keys end in ":fx". Detect and route accordingly.
  const endpoint = apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";

  const params = new URLSearchParams();
  params.set("text", text);
  params.set("target_lang", target);
  if (sourceShort) {
    const src = sourceShort.trim().toLowerCase().split("-")[0].toUpperCase();
    // Only pass source_lang if it's a plausible 2-letter code — DeepL
    // rejects unknown codes, and auto-detection is fine when unsure.
    if (/^[A-Z]{2}$/.test(src)) params.set("source_lang", src);
  }

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      cache: "no-store",
    });
  } catch (e) {
    return NextResponse.json(
      { error: "network_error", detail: (e as Error).message },
      { status: 502 },
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    return NextResponse.json(
      { error: "provider_error", status: res.status, detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return bad("provider_bad_response", 502);
  }
  const translations = (json as { translations?: Array<{ text?: string; detected_source_language?: string }> })
    ?.translations ?? [];
  const first = translations[0];
  const translated = typeof first?.text === "string" ? first.text : "";
  if (!translated) return bad("provider_empty_response", 502);

  return NextResponse.json({
    translated,
    sourceLang: first?.detected_source_language?.toLowerCase() || undefined,
  });
}

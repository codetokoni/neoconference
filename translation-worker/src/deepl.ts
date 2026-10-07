/**
 * DeepL translate helper.
 *
 * The DeepL API key ending in `:fx` is the Free tier — API base is
 * api-free.deepl.com. Anything else is Pro at api.deepl.com. This
 * mirrors what the LiveKit-room translation feature does so operators
 * can share one key across both surfaces.
 */

import { deeplTarget } from "./languages.js";

const FREE_SUFFIX = ":fx";

function baseUrl(apiKey: string): string {
  return apiKey.endsWith(FREE_SUFFIX)
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com";
}

export async function translate(
  apiKey: string,
  text: string,
  targetLang: string,
  sourceLang = "EN",
): Promise<string> {
  // The app's codes map to DeepL's in languages.ts (PT-BR / PT-PT and the
  // two Chinese scripts are separate targets there).
  const target = deeplTarget(targetLang);
  if (!target) throw new Error(`no DeepL target for "${targetLang}"`);
  const body = new URLSearchParams({
    text,
    source_lang: sourceLang,
    target_lang: target,
    preserve_formatting: "1",
  });

  const res = await fetch(baseUrl(apiKey) + "/v2/translate", {
    method: "POST",
    headers: {
      Authorization: "DeepL-Auth-Key " + apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`DeepL ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { translations: { text: string }[] };
  return json.translations[0]?.text ?? "";
}

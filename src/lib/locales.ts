// src/lib/locales.ts
//
// Caption locale catalog used by the LiveCaptions overlay and any UI
// caption-language picker. Codes follow BCP-47 short tags so they map
// directly onto LiveKit's TranscriptionSegment.language field when an
// agents-side translation pipeline is configured.

export type CaptionLocale = {
  code: string;
  label: string;
  native: string;
};

export const CAPTION_LOCALES: CaptionLocale[] = [
  { code: "auto", label: "Auto", native: "Auto" },
  { code: "en", label: "English", native: "English" },
  { code: "es", label: "Spanish", native: "Español" },
  { code: "fr", label: "French", native: "Français" },
  { code: "de", label: "German", native: "Deutsch" },
  { code: "pt", label: "Portuguese", native: "Português" },
  { code: "it", label: "Italian", native: "Italiano" },
  { code: "nl", label: "Dutch", native: "Nederlands" },
  { code: "ja", label: "Japanese", native: "日本語" },
  { code: "ko", label: "Korean", native: "한국어" },
  { code: "zh", label: "Chinese", native: "中文" },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "ar", label: "Arabic", native: "العربية" },
  { code: "ru", label: "Russian", native: "Русский" },
  { code: "tr", label: "Turkish", native: "Türkçe" },
  { code: "pl", label: "Polish", native: "Polski" },
];

export const CAPTION_LOCALE_STORAGE_KEY = "neo:captions:locale";

export function isKnownCaptionLocale(code: string | null | undefined): boolean {
  if (!code) return false;
  return CAPTION_LOCALES.some((l) => l.code === code);
}

export function findCaptionLocale(code: string | null | undefined): CaptionLocale | undefined {
  if (!code) return undefined;
  return CAPTION_LOCALES.find((l) => l.code === code);
}

// src/lib/translationLanguages.ts
//
// What live translation can put a meeting into: every target language
// DeepL translates to (developers.deepl.com, "Supported languages",
// checked 2026-10-01), one entry per language. Regional duplicates are
// folded into one, except Brazilian Portuguese and Traditional Chinese,
// where readers really differ.
//
// This is the listener's side. What a speaker can be transcribed from is
// a separate, shorter list (src/lib/locales.ts): captions have to exist
// before they can be translated.
//
// The app keeps a copy (mobile/lib/src/events/languages.dart), generated
// from the same rows, so both offer the same languages and the server
// accepts every one of them.

export type TranslationLanguage = {
  /** Our code: lower-case, as stored and sent by web and app. */
  code: string;
  /** DeepL's target_lang. */
  deepl: string;
  label: string;
  /** The language's own name — someone scanning for theirs looks for "Kiswahili". */
  native: string;
};

export const TRANSLATION_LANGUAGES: TranslationLanguage[] = [
  { code: "ace", deepl: "ACE", label: "Acehnese", native: "Acehnese" },
  { code: "af", deepl: "AF", label: "Afrikaans", native: "Afrikaans" },
  { code: "sq", deepl: "SQ", label: "Albanian", native: "Shqip" },
  { code: "ar", deepl: "AR", label: "Arabic", native: "العربية" },
  { code: "an", deepl: "AN", label: "Aragonese", native: "Aragonese" },
  { code: "hy", deepl: "HY", label: "Armenian", native: "Հայերեն" },
  { code: "as", deepl: "AS", label: "Assamese", native: "অসমীয়া" },
  { code: "ay", deepl: "AY", label: "Aymara", native: "Aymara" },
  { code: "az", deepl: "AZ", label: "Azerbaijani", native: "Azərbaycan" },
  { code: "ba", deepl: "BA", label: "Bashkir", native: "Bashkir" },
  { code: "eu", deepl: "EU", label: "Basque", native: "Euskara" },
  { code: "be", deepl: "BE", label: "Belarusian", native: "Беларуская" },
  { code: "bn", deepl: "BN", label: "Bengali", native: "বাংলা" },
  { code: "bho", deepl: "BHO", label: "Bhojpuri", native: "भोजपुरी" },
  { code: "bs", deepl: "BS", label: "Bosnian", native: "Bosanski" },
  { code: "br", deepl: "BR", label: "Breton", native: "Brezhoneg" },
  { code: "bg", deepl: "BG", label: "Bulgarian", native: "Български" },
  { code: "my", deepl: "MY", label: "Burmese", native: "မြန်မာ" },
  { code: "yue", deepl: "YUE", label: "Cantonese", native: "粵語" },
  { code: "ca", deepl: "CA", label: "Catalan", native: "Català" },
  { code: "ceb", deepl: "CEB", label: "Cebuano", native: "Cebuano" },
  { code: "zh", deepl: "ZH-HANS", label: "Chinese", native: "中文" },
  { code: "zh-hant", deepl: "ZH-HANT", label: "Chinese (Traditional)", native: "繁體中文" },
  { code: "hr", deepl: "HR", label: "Croatian", native: "Hrvatski" },
  { code: "cs", deepl: "CS", label: "Czech", native: "Čeština" },
  { code: "da", deepl: "DA", label: "Danish", native: "Dansk" },
  { code: "prs", deepl: "PRS", label: "Dari", native: "دری" },
  { code: "nl", deepl: "NL", label: "Dutch", native: "Nederlands" },
  { code: "en", deepl: "EN-US", label: "English", native: "English" },
  { code: "eo", deepl: "EO", label: "Esperanto", native: "Esperanto" },
  { code: "et", deepl: "ET", label: "Estonian", native: "Eesti" },
  { code: "fi", deepl: "FI", label: "Finnish", native: "Suomi" },
  { code: "fr", deepl: "FR", label: "French", native: "Français" },
  { code: "gl", deepl: "GL", label: "Galician", native: "Galego" },
  { code: "ka", deepl: "KA", label: "Georgian", native: "Ქართული" },
  { code: "de", deepl: "DE", label: "German", native: "Deutsch" },
  { code: "el", deepl: "EL", label: "Greek", native: "Ελληνικά" },
  { code: "gn", deepl: "GN", label: "Guarani", native: "Guarani" },
  { code: "gu", deepl: "GU", label: "Gujarati", native: "ગુજરાતી" },
  { code: "ht", deepl: "HT", label: "Haitian Creole", native: "Haitian Creole" },
  { code: "ha", deepl: "HA", label: "Hausa", native: "Hausa" },
  { code: "he", deepl: "HE", label: "Hebrew", native: "עברית" },
  { code: "hi", deepl: "HI", label: "Hindi", native: "हिन्दी" },
  { code: "hu", deepl: "HU", label: "Hungarian", native: "Magyar" },
  { code: "is", deepl: "IS", label: "Icelandic", native: "Íslenska" },
  { code: "ig", deepl: "IG", label: "Igbo", native: "Igbo" },
  { code: "id", deepl: "ID", label: "Indonesian", native: "Indonesia" },
  { code: "ga", deepl: "GA", label: "Irish", native: "Gaeilge" },
  { code: "it", deepl: "IT", label: "Italian", native: "Italiano" },
  { code: "ja", deepl: "JA", label: "Japanese", native: "日本語" },
  { code: "jv", deepl: "JV", label: "Javanese", native: "Jawa" },
  { code: "pam", deepl: "PAM", label: "Kapampangan", native: "Pampanga" },
  { code: "kk", deepl: "KK", label: "Kazakh", native: "Қазақ тілі" },
  { code: "gom", deepl: "GOM", label: "Konkani", native: "कोंकणी" },
  { code: "ko", deepl: "KO", label: "Korean", native: "한국어" },
  { code: "kmr", deepl: "KMR", label: "Kurdish (Kurmanji)", native: "Kurdî (kurmancî)" },
  { code: "ckb", deepl: "CKB", label: "Kurdish (Sorani)", native: "کوردیی ناوەندی" },
  { code: "ky", deepl: "KY", label: "Kyrgyz", native: "Кыргызча" },
  { code: "la", deepl: "LA", label: "Latin", native: "Latin" },
  { code: "lv", deepl: "LV", label: "Latvian", native: "Latviešu" },
  { code: "ln", deepl: "LN", label: "Lingala", native: "Lingála" },
  { code: "lt", deepl: "LT", label: "Lithuanian", native: "Lietuvių" },
  { code: "lmo", deepl: "LMO", label: "Lombard", native: "Lombard" },
  { code: "lb", deepl: "LB", label: "Luxembourgish", native: "Lëtzebuergesch" },
  { code: "mk", deepl: "MK", label: "Macedonian", native: "Македонски" },
  { code: "mai", deepl: "MAI", label: "Maithili", native: "मैथिली" },
  { code: "mg", deepl: "MG", label: "Malagasy", native: "Malagasy" },
  { code: "ms", deepl: "MS", label: "Malay", native: "Melayu" },
  { code: "ml", deepl: "ML", label: "Malayalam", native: "മലയാളം" },
  { code: "mt", deepl: "MT", label: "Maltese", native: "Malti" },
  { code: "mi", deepl: "MI", label: "Maori", native: "Māori" },
  { code: "mr", deepl: "MR", label: "Marathi", native: "मराठी" },
  { code: "mn", deepl: "MN", label: "Mongolian", native: "Монгол" },
  { code: "ne", deepl: "NE", label: "Nepali", native: "नेपाली" },
  { code: "nb", deepl: "NB", label: "Norwegian", native: "Norsk bokmål" },
  { code: "oc", deepl: "OC", label: "Occitan", native: "Occitan" },
  { code: "om", deepl: "OM", label: "Oromo", native: "Oromoo" },
  { code: "pag", deepl: "PAG", label: "Pangasinan", native: "Pangasinan" },
  { code: "ps", deepl: "PS", label: "Pashto", native: "پښتو" },
  { code: "fa", deepl: "FA", label: "Persian", native: "فارسی" },
  { code: "pl", deepl: "PL", label: "Polish", native: "Polski" },
  { code: "pt", deepl: "PT-PT", label: "Portuguese", native: "Português" },
  { code: "pt-br", deepl: "PT-BR", label: "Portuguese (Brazil)", native: "Português (Brasil)" },
  { code: "pa", deepl: "PA", label: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "qu", deepl: "QU", label: "Quechua", native: "Runasimi" },
  { code: "ro", deepl: "RO", label: "Romanian", native: "Română" },
  { code: "ru", deepl: "RU", label: "Russian", native: "Русский" },
  { code: "sa", deepl: "SA", label: "Sanskrit", native: "संस्कृत भाषा" },
  { code: "sr", deepl: "SR", label: "Serbian", native: "Српски" },
  { code: "st", deepl: "ST", label: "Sesotho", native: "Sesotho" },
  { code: "scn", deepl: "SCN", label: "Sicilian", native: "Sicilian" },
  { code: "sk", deepl: "SK", label: "Slovak", native: "Slovenčina" },
  { code: "sl", deepl: "SL", label: "Slovenian", native: "Slovenščina" },
  { code: "es", deepl: "ES", label: "Spanish", native: "Español" },
  { code: "su", deepl: "SU", label: "Sundanese", native: "Basa Sunda" },
  { code: "sw", deepl: "SW", label: "Swahili", native: "Kiswahili" },
  { code: "sv", deepl: "SV", label: "Swedish", native: "Svenska" },
  { code: "tl", deepl: "TL", label: "Tagalog", native: "Filipino" },
  { code: "tg", deepl: "TG", label: "Tajik", native: "Тоҷикӣ" },
  { code: "ta", deepl: "TA", label: "Tamil", native: "தமிழ்" },
  { code: "tt", deepl: "TT", label: "Tatar", native: "Татар" },
  { code: "te", deepl: "TE", label: "Telugu", native: "తెలుగు" },
  { code: "th", deepl: "TH", label: "Thai", native: "ไทย" },
  { code: "ts", deepl: "TS", label: "Tsonga", native: "Tsonga" },
  { code: "tn", deepl: "TN", label: "Tswana", native: "Setswana" },
  { code: "tr", deepl: "TR", label: "Turkish", native: "Türkçe" },
  { code: "tk", deepl: "TK", label: "Turkmen", native: "Türkmen dili" },
  { code: "uk", deepl: "UK", label: "Ukrainian", native: "Українська" },
  { code: "ur", deepl: "UR", label: "Urdu", native: "اردو" },
  { code: "uz", deepl: "UZ", label: "Uzbek", native: "O‘zbek" },
  { code: "vi", deepl: "VI", label: "Vietnamese", native: "Tiếng Việt" },
  { code: "cy", deepl: "CY", label: "Welsh", native: "Cymraeg" },
  { code: "wo", deepl: "WO", label: "Wolof", native: "Wolof" },
  { code: "xh", deepl: "XH", label: "Xhosa", native: "IsiXhosa" },
  { code: "yi", deepl: "YI", label: "Yiddish", native: "ייִדיש" },
  { code: "zu", deepl: "ZU", label: "Zulu", native: "IsiZulu" },
];

/**
 * The languages most meetings pick, shown first where the full list
 * would be a wall (the home page, a meeting's quick picks).
 */
export const POPULAR_TRANSLATION_CODES = [
  "en", "es", "fr", "de", "pt", "it", "nl", "ja", "ko", "zh", "hi", "ar", "ru", "tr", "pl",
  "sw", "ha", "ig", "uk", "vi", "id",
];

const BY_CODE = new Map(TRANSLATION_LANGUAGES.map((l) => [l.code, l]));

export function translationLanguage(code: string | null | undefined): TranslationLanguage | undefined {
  if (!code) return undefined;
  const c = code.trim().toLowerCase();
  // An older client may send a region we fold away ("en-gb", "es-419").
  return BY_CODE.get(c) ?? BY_CODE.get(c.split("-")[0]);
}

/** DeepL's target_lang for one of our codes, or null when DeepL has none. */
export function deeplTarget(code: string | null | undefined): string | null {
  return translationLanguage(code)?.deepl ?? null;
}

/** Matches a typed search against both names and the code. */
export function matchesLanguage(l: TranslationLanguage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return l.label.toLowerCase().includes(q) || l.native.toLowerCase().includes(q) || l.code === q;
}

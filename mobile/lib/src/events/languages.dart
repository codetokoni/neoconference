import 'package:flutter/foundation.dart';

/// A language a meeting can be translated into.
@immutable
class MeetingLanguage {
  const MeetingLanguage(this.code, this.label, this.native);

  final String code;
  final String label;

  /// The language's own name, shown beside the English one — someone
  /// scanning for their language looks for "Kiswahili", not "Swahili".
  final String native;

  /// Matches a typed search against both names and the code.
  bool matches(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return label.toLowerCase().contains(q) || native.toLowerCase().contains(q) || code == q;
  }
}

/// Every language live translation can put a meeting into: each target
/// DeepL has, one per language. Generated from the same rows as the
/// web's src/lib/translationLanguages.ts, so the app offers exactly what
/// the server accepts. It used to be thirteen, and Hindi and Arabic were
/// left out long after DeepL added both.
const translationLanguages = <MeetingLanguage>[
  MeetingLanguage('ace', 'Acehnese', 'Acehnese'),
  MeetingLanguage('af', 'Afrikaans', 'Afrikaans'),
  MeetingLanguage('sq', 'Albanian', 'Shqip'),
  MeetingLanguage('ar', 'Arabic', 'العربية'),
  MeetingLanguage('an', 'Aragonese', 'Aragonese'),
  MeetingLanguage('hy', 'Armenian', 'Հայերեն'),
  MeetingLanguage('as', 'Assamese', 'অসমীয়া'),
  MeetingLanguage('ay', 'Aymara', 'Aymara'),
  MeetingLanguage('az', 'Azerbaijani', 'Azərbaycan'),
  MeetingLanguage('ba', 'Bashkir', 'Bashkir'),
  MeetingLanguage('eu', 'Basque', 'Euskara'),
  MeetingLanguage('be', 'Belarusian', 'Беларуская'),
  MeetingLanguage('bn', 'Bengali', 'বাংলা'),
  MeetingLanguage('bho', 'Bhojpuri', 'भोजपुरी'),
  MeetingLanguage('bs', 'Bosnian', 'Bosanski'),
  MeetingLanguage('br', 'Breton', 'Brezhoneg'),
  MeetingLanguage('bg', 'Bulgarian', 'Български'),
  MeetingLanguage('my', 'Burmese', 'မြန်မာ'),
  MeetingLanguage('yue', 'Cantonese', '粵語'),
  MeetingLanguage('ca', 'Catalan', 'Català'),
  MeetingLanguage('ceb', 'Cebuano', 'Cebuano'),
  MeetingLanguage('zh', 'Chinese', '中文'),
  MeetingLanguage('zh-hant', 'Chinese (Traditional)', '繁體中文'),
  MeetingLanguage('hr', 'Croatian', 'Hrvatski'),
  MeetingLanguage('cs', 'Czech', 'Čeština'),
  MeetingLanguage('da', 'Danish', 'Dansk'),
  MeetingLanguage('prs', 'Dari', 'دری'),
  MeetingLanguage('nl', 'Dutch', 'Nederlands'),
  MeetingLanguage('en', 'English', 'English'),
  MeetingLanguage('eo', 'Esperanto', 'Esperanto'),
  MeetingLanguage('et', 'Estonian', 'Eesti'),
  MeetingLanguage('fi', 'Finnish', 'Suomi'),
  MeetingLanguage('fr', 'French', 'Français'),
  MeetingLanguage('gl', 'Galician', 'Galego'),
  MeetingLanguage('ka', 'Georgian', 'Ქართული'),
  MeetingLanguage('de', 'German', 'Deutsch'),
  MeetingLanguage('el', 'Greek', 'Ελληνικά'),
  MeetingLanguage('gn', 'Guarani', 'Guarani'),
  MeetingLanguage('gu', 'Gujarati', 'ગુજરાતી'),
  MeetingLanguage('ht', 'Haitian Creole', 'Haitian Creole'),
  MeetingLanguage('ha', 'Hausa', 'Hausa'),
  MeetingLanguage('he', 'Hebrew', 'עברית'),
  MeetingLanguage('hi', 'Hindi', 'हिन्दी'),
  MeetingLanguage('hu', 'Hungarian', 'Magyar'),
  MeetingLanguage('is', 'Icelandic', 'Íslenska'),
  MeetingLanguage('ig', 'Igbo', 'Igbo'),
  MeetingLanguage('id', 'Indonesian', 'Indonesia'),
  MeetingLanguage('ga', 'Irish', 'Gaeilge'),
  MeetingLanguage('it', 'Italian', 'Italiano'),
  MeetingLanguage('ja', 'Japanese', '日本語'),
  MeetingLanguage('jv', 'Javanese', 'Jawa'),
  MeetingLanguage('pam', 'Kapampangan', 'Pampanga'),
  MeetingLanguage('kk', 'Kazakh', 'Қазақ тілі'),
  MeetingLanguage('gom', 'Konkani', 'कोंकणी'),
  MeetingLanguage('ko', 'Korean', '한국어'),
  MeetingLanguage('kmr', 'Kurdish (Kurmanji)', 'Kurdî (kurmancî)'),
  MeetingLanguage('ckb', 'Kurdish (Sorani)', 'کوردیی ناوەندی'),
  MeetingLanguage('ky', 'Kyrgyz', 'Кыргызча'),
  MeetingLanguage('la', 'Latin', 'Latin'),
  MeetingLanguage('lv', 'Latvian', 'Latviešu'),
  MeetingLanguage('ln', 'Lingala', 'Lingála'),
  MeetingLanguage('lt', 'Lithuanian', 'Lietuvių'),
  MeetingLanguage('lmo', 'Lombard', 'Lombard'),
  MeetingLanguage('lb', 'Luxembourgish', 'Lëtzebuergesch'),
  MeetingLanguage('mk', 'Macedonian', 'Македонски'),
  MeetingLanguage('mai', 'Maithili', 'मैथिली'),
  MeetingLanguage('mg', 'Malagasy', 'Malagasy'),
  MeetingLanguage('ms', 'Malay', 'Melayu'),
  MeetingLanguage('ml', 'Malayalam', 'മലയാളം'),
  MeetingLanguage('mt', 'Maltese', 'Malti'),
  MeetingLanguage('mi', 'Maori', 'Māori'),
  MeetingLanguage('mr', 'Marathi', 'मराठी'),
  MeetingLanguage('mn', 'Mongolian', 'Монгол'),
  MeetingLanguage('ne', 'Nepali', 'नेपाली'),
  MeetingLanguage('nb', 'Norwegian', 'Norsk bokmål'),
  MeetingLanguage('oc', 'Occitan', 'Occitan'),
  MeetingLanguage('om', 'Oromo', 'Oromoo'),
  MeetingLanguage('pag', 'Pangasinan', 'Pangasinan'),
  MeetingLanguage('ps', 'Pashto', 'پښتو'),
  MeetingLanguage('fa', 'Persian', 'فارسی'),
  MeetingLanguage('pl', 'Polish', 'Polski'),
  MeetingLanguage('pt', 'Portuguese', 'Português'),
  MeetingLanguage('pt-br', 'Portuguese (Brazil)', 'Português (Brasil)'),
  MeetingLanguage('pa', 'Punjabi', 'ਪੰਜਾਬੀ'),
  MeetingLanguage('qu', 'Quechua', 'Runasimi'),
  MeetingLanguage('ro', 'Romanian', 'Română'),
  MeetingLanguage('ru', 'Russian', 'Русский'),
  MeetingLanguage('sa', 'Sanskrit', 'संस्कृत भाषा'),
  MeetingLanguage('sr', 'Serbian', 'Српски'),
  MeetingLanguage('st', 'Sesotho', 'Sesotho'),
  MeetingLanguage('scn', 'Sicilian', 'Sicilian'),
  MeetingLanguage('sk', 'Slovak', 'Slovenčina'),
  MeetingLanguage('sl', 'Slovenian', 'Slovenščina'),
  MeetingLanguage('es', 'Spanish', 'Español'),
  MeetingLanguage('su', 'Sundanese', 'Basa Sunda'),
  MeetingLanguage('sw', 'Swahili', 'Kiswahili'),
  MeetingLanguage('sv', 'Swedish', 'Svenska'),
  MeetingLanguage('tl', 'Tagalog', 'Filipino'),
  MeetingLanguage('tg', 'Tajik', 'Тоҷикӣ'),
  MeetingLanguage('ta', 'Tamil', 'தமிழ்'),
  MeetingLanguage('tt', 'Tatar', 'Татар'),
  MeetingLanguage('te', 'Telugu', 'తెలుగు'),
  MeetingLanguage('th', 'Thai', 'ไทย'),
  MeetingLanguage('ts', 'Tsonga', 'Tsonga'),
  MeetingLanguage('tn', 'Tswana', 'Setswana'),
  MeetingLanguage('tr', 'Turkish', 'Türkçe'),
  MeetingLanguage('tk', 'Turkmen', 'Türkmen dili'),
  MeetingLanguage('uk', 'Ukrainian', 'Українська'),
  MeetingLanguage('ur', 'Urdu', 'اردو'),
  MeetingLanguage('uz', 'Uzbek', 'O‘zbek'),
  MeetingLanguage('vi', 'Vietnamese', 'Tiếng Việt'),
  MeetingLanguage('cy', 'Welsh', 'Cymraeg'),
  MeetingLanguage('wo', 'Wolof', 'Wolof'),
  MeetingLanguage('xh', 'Xhosa', 'IsiXhosa'),
  MeetingLanguage('yi', 'Yiddish', 'ייִדיש'),
  MeetingLanguage('zu', 'Zulu', 'IsiZulu'),
];

/// The languages most meetings pick: shown first where all of them would
/// be a wall of chips (choosing a new meeting's languages, the how-to).
const _popularCodes = [
  'en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'zh', 'hi', 'ar', 'ru', 'tr', 'pl',
  'sw', 'ha', 'ig', 'uk', 'vi', 'id',
];

final meetingLanguages = <MeetingLanguage>[
  for (final code in _popularCodes) ?languageFor(code),
];

final _byCode = {for (final l in translationLanguages) l.code: l};

/// The language for a stored code, or null when there is none.
MeetingLanguage? languageFor(String? code) {
  if (code == null || code.isEmpty) return null;
  final c = code.trim().toLowerCase();
  return _byCode[c] ?? _byCode[c.split('-').first];
}

/// The text-to-speech locale a translation is spoken in. The regional
/// voice where a language has one most phones carry; otherwise the
/// language itself, and Android picks whatever voice it has for it.
String speechLocale(String code) =>
    const {
      'en': 'en-US',
      'es': 'es-ES',
      'fr': 'fr-FR',
      'de': 'de-DE',
      'pt': 'pt-PT',
      'pt-br': 'pt-BR',
      'it': 'it-IT',
      'nl': 'nl-NL',
      'ja': 'ja-JP',
      'ko': 'ko-KR',
      'zh': 'zh-CN',
      'zh-hant': 'zh-TW',
      'ru': 'ru-RU',
      'tr': 'tr-TR',
      'pl': 'pl-PL',
      'hi': 'hi-IN',
      'ar': 'ar-SA',
    }[code] ??
    code;

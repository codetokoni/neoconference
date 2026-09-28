import 'package:flutter/foundation.dart';

/// The languages a meeting can be translated into.
///
/// Copied from src/lib/locales.ts so the app offers exactly what the web
/// offers and the server accepts. "auto" is deliberately absent: it is a
/// listener-side choice meaning "detect what is being spoken", not something
/// a host can decide a meeting will be translated into.
@immutable
class MeetingLanguage {
  const MeetingLanguage(this.code, this.label, this.native);

  final String code;
  final String label;

  /// The language's own name, shown beside the English one — someone
  /// scanning for their language looks for "Español", not "Spanish".
  final String native;
}

const meetingLanguages = <MeetingLanguage>[
  MeetingLanguage('en', 'English', 'English'),
  MeetingLanguage('es', 'Spanish', 'Español'),
  MeetingLanguage('fr', 'French', 'Français'),
  MeetingLanguage('de', 'German', 'Deutsch'),
  MeetingLanguage('pt', 'Portuguese', 'Português'),
  MeetingLanguage('it', 'Italian', 'Italiano'),
  MeetingLanguage('nl', 'Dutch', 'Nederlands'),
  MeetingLanguage('ja', 'Japanese', '日本語'),
  MeetingLanguage('ko', 'Korean', '한국어'),
  MeetingLanguage('zh', 'Chinese', '中文'),
  MeetingLanguage('hi', 'Hindi', 'हिन्दी'),
  MeetingLanguage('ar', 'Arabic', 'العربية'),
  MeetingLanguage('ru', 'Russian', 'Русский'),
  MeetingLanguage('tr', 'Turkish', 'Türkçe'),
  MeetingLanguage('pl', 'Polish', 'Polski'),
];

/// Languages live translation can put a meeting into: the server's DeepL
/// targets (src/app/api/translate). Hindi and Arabic are meeting languages
/// DeepL cannot translate into, and offering them only ever produced
/// "target not supported".
final translationLanguages = <MeetingLanguage>[
  for (final language in meetingLanguages)
    if (language.code != 'hi' && language.code != 'ar') language,
];

/// The text-to-speech locale a translation is spoken in.
String speechLocale(String code) =>
    const {
      'en': 'en-US',
      'es': 'es-ES',
      'fr': 'fr-FR',
      'de': 'de-DE',
      'pt': 'pt-PT',
      'it': 'it-IT',
      'nl': 'nl-NL',
      'ja': 'ja-JP',
      'ko': 'ko-KR',
      'zh': 'zh-CN',
      'ru': 'ru-RU',
      'tr': 'tr-TR',
      'pl': 'pl-PL',
    }[code] ??
    code;

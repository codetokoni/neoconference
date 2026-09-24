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

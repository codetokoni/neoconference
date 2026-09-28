import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/events/languages.dart';
import 'package:neoconference/src/room/translation_voice.dart';

/// Hearing a meeting in your language on the phone.
///
/// The phone only showed translated captions; the web read them aloud.
void main() {
  group('when a translation is read aloud', () {
    test('someone else speaking, your mic off: read it', () {
      expect(shouldSpeakTranslation(speakOn: true, micOn: false, fromMe: false), isTrue);
    });

    test('not while your microphone is on — it would hear itself and loop', () {
      expect(shouldSpeakTranslation(speakOn: true, micOn: true, fromMe: false), isFalse);
    });

    test('never your own words', () {
      expect(shouldSpeakTranslation(speakOn: true, micOn: false, fromMe: true), isFalse);
    });

    test('not when reading aloud is switched off', () {
      expect(shouldSpeakTranslation(speakOn: false, micOn: false, fromMe: false), isFalse);
    });
  });

  group('languages offered for translation', () {
    test('only what the server can translate into', () {
      final codes = translationLanguages.map((l) => l.code).toList();
      expect(codes, isNot(contains('hi')));
      expect(codes, isNot(contains('ar')));
      // The server's DeepL targets (src/app/api/translate/route.ts).
      expect(codes.toSet(), {'en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'zh', 'ru', 'tr', 'pl'});
    });

    test('each is read in a proper locale', () {
      expect(speechLocale('es'), 'es-ES');
      expect(speechLocale('zh'), 'zh-CN');
      for (final language in translationLanguages) {
        expect(speechLocale(language.code), contains('-'), reason: language.code);
      }
    });
  });
}

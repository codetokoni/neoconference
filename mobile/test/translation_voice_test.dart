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
    test('every DeepL target, once each, Hindi and Arabic included', () {
      final codes = translationLanguages.map((l) => l.code).toList();
      // The server's list (src/lib/translationLanguages.ts) has the same rows.
      expect(codes.length, greaterThanOrEqualTo(110));
      expect(codes.toSet().length, codes.length);
      expect(codes, containsAll(['en', 'es', 'fr', 'de', 'pt', 'zh', 'hi', 'ar', 'sw', 'ha', 'ig', 'pt-br', 'zh-hant']));
      for (final code in codes) {
        // What the server's create route accepts as a meeting language.
        expect(RegExp(r'^[a-z]{2,3}(-[a-z0-9]{2,8})?$').hasMatch(code), isTrue, reason: code);
      }
    });

    test('the popular picks are all real languages', () {
      expect(meetingLanguages.length, greaterThanOrEqualTo(15));
      for (final l in meetingLanguages) {
        expect(languageFor(l.code), same(l));
      }
      expect(languageFor('en-GB')?.code, 'en');
      expect(languageFor('xx'), isNull);
    });

    test('each is read in a proper locale where phones have one', () {
      expect(speechLocale('es'), 'es-ES');
      expect(speechLocale('zh'), 'zh-CN');
      expect(speechLocale('pt-br'), 'pt-BR');
      // The long tail is the language itself; Android finds its voice.
      expect(speechLocale('sw'), 'sw');
    });

    test('search finds a language by either name', () {
      final sw = languageFor('sw')!;
      expect(sw.matches('swa'), isTrue);
      expect(sw.matches('Kiswahili'), isTrue);
      expect(sw.matches('french'), isFalse);
    });
  });
}

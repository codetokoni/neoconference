import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_tts/flutter_tts.dart';

import '../events/languages.dart';

/// Whether a translated caption should be read aloud.
///
/// Not while this device's own microphone is open: the phone's speaker
/// would be picked up by it, transcribed, translated and read out again —
/// the web's LiveTranslation stays silent for the same reason. And never
/// this device's own words, which the person already knows.
bool shouldSpeakTranslation({
  required bool speakOn,
  required bool micOn,
  required bool fromMe,
}) =>
    speakOn && !micOn && !fromMe;

/// Reads translated captions aloud, one after another, in the listener's
/// language — what the web does with speechSynthesis, so a phone hears the
/// meeting in its language rather than only reading it.
///
/// While it speaks, [duck] turns the meeting's own sound down (to 15%, as
/// on the web) so the translation is heard over the speaker; it is turned
/// back up once nothing is left to say.
class TranslationVoice {
  TranslationVoice({required this.duck});

  final Future<void> Function(bool ducked) duck;

  FlutterTts? _tts;
  String? _language;
  Future<void> _chain = Future.value();
  int _queued = 0;
  bool _disposed = false;

  /// How many have been spoken, for the sheet's status and for logs.
  int spoken = 0;

  Future<FlutterTts> _engine() async {
    final existing = _tts;
    if (existing != null) return existing;
    final tts = FlutterTts();
    // Each utterance is awaited in turn, so a burst of captions is read in
    // order instead of cutting one another off.
    await tts.awaitSpeakCompletion(true);
    await tts.setSpeechRate(0.5);
    _tts = tts;
    return tts;
  }

  /// Queues [text] to be read in [languageCode].
  void speak(String text, String languageCode) {
    if (_disposed || text.trim().isEmpty) return;
    _queued++;
    _chain = _chain.then((_) => _say(text, languageCode)).catchError((Object e) {
      debugPrint('[translation-voice] failed: $e');
    });
  }

  Future<void> _say(String text, String languageCode) async {
    try {
      if (_disposed) return;
      final tts = await _engine();
      if (_language != languageCode) {
        final result = await tts.setLanguage(speechLocale(languageCode));
        _language = languageCode;
        debugPrint('[translation-voice] language ${speechLocale(languageCode)} -> $result');
      }
      if (_queued == 1) await duck(true);
      await tts.speak(text);
      spoken++;
      debugPrint('[translation-voice] spoke ${text.length} chars in $languageCode (#$spoken)');
    } finally {
      _queued--;
      if (_queued == 0 && !_disposed) await duck(false);
    }
  }

  /// Stops speaking and forgets what was queued.
  Future<void> stop() async {
    _queued = 0;
    _chain = Future.value();
    await _tts?.stop();
    await duck(false);
  }

  Future<void> dispose() async {
    _disposed = true;
    await _tts?.stop();
  }
}

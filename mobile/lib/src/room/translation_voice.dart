import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

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
/// The speaking is Android's own text-to-speech on the call's audio path
/// (MeetingVoice.kt): at the call's volume and on its route. The first
/// version used the media stream, and on a phone whose media volume was at
/// 0 the translation showed and was never heard.
///
/// While it speaks, [duck] turns the meeting's own sound down (to 15%, as
/// on the web) so the translation is heard over it; it is turned back up
/// once nothing is left to say.
class TranslationVoice {
  TranslationVoice({required this.duck, MethodChannel? channel})
      : _channel = channel ?? const MethodChannel('app.neoconference/voice');

  final Future<void> Function(bool ducked) duck;
  final MethodChannel _channel;

  Future<void> _chain = Future.value();
  int _queued = 0;
  bool _disposed = false;

  /// How many have been spoken, for logs.
  int spoken = 0;

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
      if (_queued == 1) await duck(true);
      final result = await _channel.invokeMapMethod<String, dynamic>('speak', {
        'text': text,
        'language': speechLocale(languageCode),
      });
      final status = result?['status'];
      if (status == 'done') {
        spoken++;
        debugPrint('[translation-voice] spoke ${text.length} chars in $languageCode (#$spoken)');
      } else {
        debugPrint('[translation-voice] $status: ${result?['message']}');
      }
    } on MissingPluginException {
      // No native side (a test, or a platform without it): text only.
    } finally {
      _queued--;
      if (_queued == 0 && !_disposed) await duck(false);
    }
  }

  /// Stops speaking and forgets what was queued.
  Future<void> stop() async {
    _queued = 0;
    _chain = Future.value();
    try {
      await _channel.invokeMethod('stop');
    } on MissingPluginException {
      // Nothing was speaking.
    }
    await duck(false);
  }

  Future<void> dispose() async {
    _disposed = true;
    try {
      await _channel.invokeMethod('stop');
    } on MissingPluginException {
      // Nothing was speaking.
    }
  }
}

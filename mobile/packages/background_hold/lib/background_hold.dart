import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Keeps the app's process running while it finishes something the person
/// started from a notification without opening the app (Decline on a
/// call): a short foreground service, with a quiet notification saying
/// what is happening.
///
/// Without it, phones that freeze background apps (ColorOS freezes one
/// 5 s after a notification button wakes it) can stop the work halfway,
/// and nothing is ever sent. The plugin is registered on every engine, so
/// this works from the isolate a notification button runs in, which the
/// app's own channels never reach.
class BackgroundHold {
  BackgroundHold._();

  static const _channel = MethodChannel('app.neoconference/hold');

  /// Starts holding; false when Android would not allow it (the work then
  /// runs anyway, unprotected).
  static Future<bool> start(String text) async {
    try {
      return await _channel.invokeMethod<bool>('start', {'text': text}) ?? false;
    } catch (e) {
      debugPrint('[hold] start: $e');
      return false;
    }
  }

  static Future<void> stop() async {
    try {
      await _channel.invokeMethod<void>('stop');
    } catch (e) {
      debugPrint('[hold] stop: $e');
    }
  }
}

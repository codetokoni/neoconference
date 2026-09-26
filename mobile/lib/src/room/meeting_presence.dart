import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Keeping the meeting alive when the app is not on screen.
///
/// Two things no Flutter widget can do for itself:
///
///  - **Background audio.** Android stops scheduling a backgrounded process
///    within seconds, and kills one capturing a microphone without a
///    foreground service of a matching type. The app has declared the
///    permissions for one since it shipped and never started it, so audio
///    stopped whenever the phone was pocketed.
///  - **Picture in Picture.** An Activity-level call, and the Activity has
///    to report the mode change back so the UI can shrink to something
///    legible at a few centimetres wide.
///
/// **Android only.** iOS needs its own work — an AVAudioSession configured
/// for voice chat, the `voip` background mode, and AVPictureInPicture
/// around the video layer — and none of it exists here. [supported] is
/// false everywhere but Android, and every method is a no-op there rather
/// than pretending.
class MeetingPresence {
  MeetingPresence._();

  static final instance = MeetingPresence._();

  static const _channel = MethodChannel('app.neoconference/meeting');

  /// Whether the platform side of this exists at all.
  static bool get supported => !kIsWeb && Platform.isAndroid;

  /// True while the meeting is floating in a Picture in Picture window.
  final ValueNotifier<bool> inPip = ValueNotifier<bool>(false);

  /// True while a phone call is ringing or in progress.
  ///
  /// Only ever set when READ_PHONE_STATE has been granted. Without it this
  /// stays false for the whole meeting — the Android side does not guess
  /// from the audio mode, which was measured to stay stale after a call.
  final ValueNotifier<bool> onPhoneCall = ValueNotifier<bool>(false);

  /// Goes up by one each time Android reports a usable network. A count
  /// rather than a flag, so two returns in a row are two signals.
  final ValueNotifier<int> networkReturns = ValueNotifier<int>(0);

  bool _wired = false;
  bool _pipAvailable = false;

  /// Whether this device can float the meeting.
  ///
  /// Android TV and some manufacturers' builds report the feature absent,
  /// and a "Float" control that does nothing is worse than none.
  bool get pipAvailable => _pipAvailable;

  void _wire() {
    if (_wired) return;
    _wired = true;
    _channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'pipChanged':
          inPip.value = call.arguments == true;
        case 'phoneCall':
          onPhoneCall.value = call.arguments == true;
        case 'networkAvailable':
          networkReturns.value++;
      }
      return null;
    });
  }

  /// Start the foreground service. Call this once the room is connected.
  ///
  /// Failures are swallowed deliberately: a meeting that is otherwise
  /// working must not be torn down because a notification could not be
  /// posted. The cost of failing is that audio stops when backgrounded,
  /// which is exactly where this started.
  Future<void> begin({required String title}) async {
    if (!supported) return;
    _wire();
    try {
      await _channel.invokeMethod<bool>('startMeeting', {'title': title});
      _pipAvailable = await _channel.invokeMethod<bool>('pipSupported') ?? false;
    } catch (e) {
      debugPrint('[presence] could not start the meeting service: $e');
    }
  }

  /// Stop the service. Call this on leave, and on dispose.
  ///
  /// Idempotent, because both of those can happen for the same meeting.
  Future<void> end() async {
    if (!supported) return;
    try {
      await _channel.invokeMethod<bool>('stopMeeting');
    } catch (e) {
      debugPrint('[presence] could not stop the meeting service: $e');
    }
    inPip.value = false;
    // A call still ringing when the meeting ends belongs to no meeting.
    onPhoneCall.value = false;
  }

  /// Ask for the permission that routes call audio to Bluetooth.
  ///
  /// Declared in the manifest since the app shipped and never requested,
  /// so it was never granted: with earbuds connected and the headset
  /// route chosen, Android put the call on the earpiece. Media still
  /// played through the earbuds over A2DP, which is why this looked like
  /// it worked.
  ///
  /// Returns whether it is already held. The dialog answers
  /// asynchronously and is not waited on — a meeting must not block on a
  /// permission prompt.
  Future<bool> ensureBluetooth() async {
    if (!supported) return false;
    try {
      return await _channel.invokeMethod<bool>('ensureBluetooth') ?? false;
    } catch (e) {
      debugPrint('[presence] could not request Bluetooth: $e');
      return false;
    }
  }

  /// Ask for the permission that lets the meeting notice a phone call.
  ///
  /// Returns whether it is already held. Not waited on: the Android side
  /// starts watching by itself if the grant arrives mid-meeting.
  Future<bool> ensurePhoneState() async {
    if (!supported) return false;
    try {
      return await _channel.invokeMethod<bool>('ensurePhoneState') ?? false;
    } catch (e) {
      debugPrint('[presence] could not request phone state: $e');
      return false;
    }
  }

  /// Ready the platform for a screen share: the meeting's service takes the
  /// media-projection type Android 14 requires before any screen capture.
  /// Call after the person has agreed to the capture.
  ///
  /// Returns false when that could not be done; sharing then would crash
  /// the app, so the caller must not start it.
  Future<bool> beginScreenShare() async {
    if (!supported) return true;
    try {
      return await _channel.invokeMethod<bool>('beginScreenShare') ?? false;
    } catch (e) {
      debugPrint('[presence] could not prepare screen share: $e');
      return false;
    }
  }

  /// Drop the media-projection type again once sharing has stopped.
  Future<void> endScreenShare() async {
    if (!supported) return;
    try {
      await _channel.invokeMethod<bool>('endScreenShare');
    } catch (e) {
      debugPrint('[presence] could not end screen share: $e');
    }
  }

  /// Float the meeting now.
  ///
  /// Returns false when the platform refused — PiP is disabled per-app in
  /// Android settings, and the caller should say so rather than appear to
  /// have done nothing.
  Future<bool> enterPip() async {
    if (!supported) return false;
    try {
      return await _channel.invokeMethod<bool>('enterPip') ?? false;
    } catch (e) {
      debugPrint('[presence] could not enter PiP: $e');
      return false;
    }
  }
}

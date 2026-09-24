import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';

/// Where the meeting's sound goes, and what it is captured with.
///
/// Reads the real device list from LiveKit's [Hardware], which wraps
/// WebRTC's own enumeration, and follows [Hardware.onDeviceChange] so a
/// headset that is plugged in or a pair of earbuds that connects appears
/// without anyone reopening a sheet.
///
/// Two honest limits, both of them the platform's rather than choices:
///
///  - **Input cannot be chosen on a phone.** `selectAudioInput` is
///    Windows and macOS only; on Android the OS picks the microphone that
///    matches the output route. Inputs are therefore listed and never
///    offered as a choice.
///  - **Bluetooth names need a runtime grant.** Without BLUETOOTH_CONNECT
///    Android hands back a generic label rather than the headset's name.
///    The route still works; it is just less specific.
class AudioRoutes extends ChangeNotifier {
  AudioRoutes._() {
    _subscription = Hardware.instance.onDeviceChange.stream.listen((devices) {
      _apply(devices);
    });
    unawaited(refresh());
  }

  static final AudioRoutes instance = AudioRoutes._();

  StreamSubscription<List<MediaDevice>>? _subscription;

  List<MediaDevice> _outputs = const [];
  List<MediaDevice> _inputs = const [];
  List<MediaDevice> _cameras = const [];
  MediaDevice? _selectedOutput;
  Object? _error;

  /// Every audio output the device reports. Empty until the first read.
  List<MediaDevice> get outputs => _outputs;

  /// Microphones, for showing — not for choosing. See the class comment.
  List<MediaDevice> get inputs => _inputs;

  List<MediaDevice> get cameras => _cameras;

  /// What sound is currently coming out of, as far as the SDK knows.
  MediaDevice? get selectedOutput => _selectedOutput;

  /// Why the device list is empty, when it is empty for a reason.
  Object? get error => _error;

  /// Whether this platform lets the app move the audio at all.
  bool get canRoute => AudioManager.instance.canSwitchSpeakerphone;

  bool get speakerPreferred => AudioManager.instance.isSpeakerOutputPreferred;

  /// Whether anything that looks like a headset is attached right now.
  ///
  /// Used to decide whether the route is worth mentioning: on a phone with
  /// nothing plugged in, "Speaker" is the only answer and a picker offering
  /// one item is noise.
  bool get hasExternalRoute => _outputs.any(
        (d) => routeKind(d) == AudioRouteKind.bluetooth ||
            routeKind(d) == AudioRouteKind.wired,
      );

  Future<void> refresh() async {
    try {
      final devices = await Hardware.instance.enumerateDevices();
      _apply(devices);
      _error = null;
    } catch (e) {
      // An enumeration that throws must not take the meeting with it. The
      // sheet says it could not read the devices instead of showing an
      // empty list, which would read as "you have no speaker".
      _error = e;
      notifyListeners();
    }
  }

  void _apply(List<MediaDevice> devices) {
    final before = _inputs.length;

    _outputs = devices.where((d) => d.kind == 'audiooutput').toList();
    _inputs = devices.where((d) => d.kind == 'audioinput').toList();
    _cameras = devices.where((d) => d.kind == 'videoinput').toList();
    _selectedOutput = Hardware.instance.selectedAudioOutput ??
        (_outputs.isNotEmpty ? _outputs.first : null);

    // Make the route follow the hardware.
    //
    // Found on a phone: earbuds connected during a meeting and the call
    // stayed on the earpiece until the route was chosen again by hand.
    // Android applies the speaker preference when it is set, not when the
    // devices change, so re-applying the *current* preference is what
    // lets a newly connected headset take over. Choosing Speaker on
    // purpose still wins, because that is the preference being re-applied.
    if (_inputs.length != before && canRoute) {
      unawaited(
        AudioManager.instance
            .setSpeakerOutputPreferred(speakerPreferred)
            .catchError((Object e) {
          debugPrint('[audio] could not re-apply the route: $e');
        }),
      );
    }

    notifyListeners();
  }

  /// Move the sound to [device].
  ///
  /// Returns false when the platform refused, so a caller can say so
  /// rather than leave a row looking selected when nothing moved.
  Future<bool> select(MediaDevice device) async {
    try {
      await Hardware.instance.selectAudioOutput(device);
      // Speaker and everything-else are separate switches on Android: the
      // speakerphone preference overrides the route, so choosing earbuds
      // while it is on would put the sound back on the speaker.
      if (canRoute) {
        await AudioManager.instance.setSpeakerOutputPreferred(
          routeKind(device) == AudioRouteKind.speaker,
        );
      }
      _selectedOutput = device;
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('[audio] could not select ${device.label}: $e');
      return false;
    }
  }

  /// The loudspeaker, or whatever else is attached.
  Future<void> setSpeaker(bool on) async {
    if (!canRoute) return;
    try {
      await AudioManager.instance.setSpeakerOutputPreferred(on);
      notifyListeners();
    } catch (e) {
      debugPrint('[audio] could not set the speaker preference: $e');
    }
  }

  /// What kind of thing a device is, worked out from what the platform
  /// calls it.
  ///
  /// WebRTC does not classify outputs, so this reads the id and label. It
  /// is a guess used only to pick an icon and a sensible order — nothing
  /// depends on it being right, and an unrecognised device is still
  /// listed and still selectable under its own name.
  static AudioRouteKind routeKind(MediaDevice device) {
    final text = '${device.deviceId} ${device.label}'.toLowerCase();
    if (text.contains('bluetooth') || text.contains('headset') && !text.contains('wired')) {
      return AudioRouteKind.bluetooth;
    }
    if (text.contains('wired') || text.contains('headphone')) {
      return AudioRouteKind.wired;
    }
    if (text.contains('speaker')) return AudioRouteKind.speaker;
    if (text.contains('earpiece') || text.contains('receiver')) {
      return AudioRouteKind.earpiece;
    }
    return AudioRouteKind.other;
  }

  /// A name worth showing.
  ///
  /// Android returns an empty label for some routes and a bare id for
  /// others, and "audiooutput-3" tells nobody anything.
  static String label(MediaDevice device) {
    final raw = device.label.trim();
    if (raw.isNotEmpty) return raw;
    return switch (routeKind(device)) {
      AudioRouteKind.bluetooth => 'Bluetooth',
      AudioRouteKind.wired => 'Wired headphones',
      AudioRouteKind.speaker => 'Speaker',
      AudioRouteKind.earpiece => 'Earpiece',
      AudioRouteKind.other => device.deviceId,
    };
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }
}

enum AudioRouteKind { speaker, earpiece, wired, bluetooth, other }

import 'dart:async';

import 'package:livekit_client/livekit_client.dart';

/// Decides when the meeting should say this device's connection is weak.
///
/// The source is LiveKit's own verdict on this participant — the server
/// scores packet loss and jitter and sends the result down the signal
/// connection. Nothing in the app listened to it, so the header's "Weak
/// connection" state existed in the design and was never shown.
///
/// Weak comes on at the first poor or lost report: the server already
/// averages over a window before it says so, and the person on a bad link
/// is the one who needs to know their voice is breaking up.
/// It goes off only after the link has stayed good for [settle]. A link on
/// the edge swings between poor and good every few seconds, and a header
/// flickering between the two is noise nobody can act on.
class WeakLinkPolicy {
  WeakLinkPolicy({
    required this.onChange,
    this.settle = const Duration(seconds: 5),
    Timer Function(Duration, void Function())? schedule,
  }) : _schedule = schedule ?? Timer.new;

  final void Function(bool weak) onChange;
  final Duration settle;
  final Timer Function(Duration, void Function()) _schedule;

  bool _weak = false;
  Timer? _clear;

  bool get weak => _weak;

  void report(ConnectionQuality quality) {
    switch (quality) {
      case ConnectionQuality.poor:
      case ConnectionQuality.lost:
        _clear?.cancel();
        _clear = null;
        if (!_weak) {
          _weak = true;
          onChange(true);
        }
      case ConnectionQuality.good:
      case ConnectionQuality.excellent:
        if (!_weak || _clear != null) return;
        _clear = _schedule(settle, () {
          _clear = null;
          _weak = false;
          onChange(false);
        });
      case ConnectionQuality.unknown:
        // No verdict is not a good one. Keep whatever was last said.
        break;
    }
  }

  void dispose() {
    _clear?.cancel();
    _clear = null;
  }
}

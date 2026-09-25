import 'dart:async';

/// Gives up on a reconnect that is not going to finish.
///
/// LiveKit reports "reconnecting" and is trusted to follow it with either
/// "reconnected" or "disconnected". Measured, it does not always:
///
///  - a real phone (Samsung, Wi-Fi) closed both of its peer connections
///    and then sat on "Reconnecting…" for over five minutes, showing a
///    participant who had long since left;
///  - an emulator cut to 1 kbps stayed "Reconnecting…" for nine and a half
///    minutes.
///
/// Neither ever got a disconnect, so neither could offer Rejoin. After
/// [timeout] this calls [onGiveUp], and the meeting is treated as dropped.
/// A reconnect that does finish in time cancels it.
class ReconnectWatchdog {
  ReconnectWatchdog({
    required this.onGiveUp,
    this.timeout = const Duration(seconds: 45),
    Timer Function(Duration, void Function())? schedule,
  }) : _schedule = schedule ?? Timer.new;

  final void Function() onGiveUp;
  final Duration timeout;
  final Timer Function(Duration, void Function()) _schedule;

  Timer? _timer;

  bool get waiting => _timer != null;

  /// The link went down. Starts the clock once; repeated reports during
  /// the same outage do not restart it.
  void reconnecting() {
    _timer ??= _schedule(timeout, () {
      _timer = null;
      onGiveUp();
    });
  }

  /// The link came back, or the meeting ended some other way.
  void settled() {
    _timer?.cancel();
    _timer = null;
  }

  void dispose() => settled();
}

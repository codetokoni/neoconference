import 'dart:async';

/// Gets back into a meeting the network dropped, without a tap.
///
/// Tries on a fixed interval, and at once whenever the network comes back
/// — the interval matters as much as the signal: on a real phone the
/// meeting connection died with Wi-Fi up the whole time, so "the network
/// returned" never fires for that kind of drop.
///
/// Stops trying after [window]. Past that the person gets the Rejoin
/// button instead: a phone left in a pocket must not put itself back into
/// a meeting an hour later.
///
/// Only one attempt runs at a time. A network signal during an attempt is
/// ignored rather than queued — the attempt in flight is already the
/// answer to it.
class AutoRejoin {
  AutoRejoin({
    required this.attempt,
    required this.onExpired,
    this.window = const Duration(minutes: 5),
    this.interval = const Duration(seconds: 5),
    this.firstTry = const Duration(seconds: 1),
    DateTime Function()? now,
    Timer Function(Duration, void Function())? schedule,
  })  : _now = now ?? DateTime.now,
        _schedule = schedule ?? Timer.new;

  /// One try at getting back in. True when it got an answer — in the
  /// meeting, or at a gate such as the waiting room — and false when it
  /// should be tried again.
  final Future<bool> Function() attempt;

  /// Called once, when [window] runs out without getting back in.
  final void Function() onExpired;

  final Duration window;
  final Duration interval;
  final Duration firstTry;
  final DateTime Function() _now;
  final Timer Function(Duration, void Function()) _schedule;

  bool _active = false;
  bool _inFlight = false;
  DateTime? _deadline;
  Timer? _timer;

  bool get active => _active;

  void start() {
    if (_active) return;
    _active = true;
    _deadline = _now().add(window);
    _next(firstTry);
  }

  /// The device has a network again. Try now instead of at the next tick.
  void networkAvailable() {
    if (!_active || _inFlight) return;
    _timer?.cancel();
    _timer = null;
    unawaited(_run());
  }

  void stop() {
    _active = false;
    _timer?.cancel();
    _timer = null;
  }

  void _next(Duration after) {
    _timer?.cancel();
    _timer = _schedule(after, () => unawaited(_run()));
  }

  bool get _expired => _now().isAfter(_deadline!);

  Future<void> _run() async {
    _timer = null;
    if (!_active || _inFlight) return;
    if (_expired) return _expire();

    _inFlight = true;
    bool answered;
    try {
      answered = await attempt();
    } catch (_) {
      answered = false;
    }
    _inFlight = false;

    if (!_active) return;
    if (answered) return stop();
    if (_expired) return _expire();
    _next(interval);
  }

  void _expire() {
    stop();
    onExpired();
  }
}

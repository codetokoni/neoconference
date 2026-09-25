import 'dart:async';

/// How often to ask the server for chat, given what the person can see.
///
/// Chat in this app arrives by polling — LiveKit's reliable data channel,
/// which the web client sends chat on, never reaches this SDK — and it
/// polled every 4 s, open or closed, foreground or pocketed: measured on
/// the phone, 112 requests in 7½ minutes for a chat nobody had open. Every
/// person in a meeting pays that, and so does the server, per person.
///
/// Four seconds is right while the chat is on screen. With it closed, the
/// only thing a poll feeds is the unread badge, and 15 s is soon enough for
/// that. With the app in the background nothing shows at all; a slow poll
/// keeps the history close to current for when they come back.
Duration chatPollInterval({required bool chatOpen, required bool visible}) {
  if (chatOpen) return const Duration(seconds: 4);
  if (visible) return const Duration(seconds: 15);
  return const Duration(seconds: 60);
}

/// Runs the chat poll at [chatPollInterval], one request at a time.
///
/// A fixed periodic timer, as before, starts the next request whether or
/// not the last one has answered; on a slow link they pile up. This waits
/// for each poll before scheduling the next, and reschedules when what the
/// person can see changes.
class ChatPoller {
  ChatPoller({
    required this.poll,
    Timer Function(Duration, void Function())? schedule,
  }) : _schedule = schedule ?? Timer.new;

  final Future<void> Function() poll;
  final Timer Function(Duration, void Function()) _schedule;

  bool _running = false;
  bool _chatOpen = false;
  bool _visible = true;
  bool _inFlight = false;
  Timer? _timer;

  Duration get interval =>
      chatPollInterval(chatOpen: _chatOpen, visible: _visible);

  void start() {
    if (_running) return;
    _running = true;
    _next();
  }

  void stop() {
    _running = false;
    _timer?.cancel();
    _timer = null;
  }

  /// The chat was opened or closed.
  void chatOpen(bool open) {
    if (open == _chatOpen) return;
    _chatOpen = open;
    // Opening it should show what is there now, not in up to a minute.
    if (open) {
      _pollNow();
    } else {
      _next();
    }
  }

  /// The meeting came on screen, or left it.
  void visible(bool visible) {
    if (visible == _visible) return;
    _visible = visible;
    // Coming back to the meeting after a while away: catch up at once.
    if (visible) {
      _pollNow();
    } else {
      _next();
    }
  }

  void _pollNow() {
    if (!_running || _inFlight) return;
    _timer?.cancel();
    _timer = null;
    unawaited(_run());
  }

  void _next() {
    if (!_running || _inFlight) return;
    _timer?.cancel();
    _timer = _schedule(interval, () => unawaited(_run()));
  }

  Future<void> _run() async {
    _timer = null;
    if (!_running || _inFlight) return;
    _inFlight = true;
    try {
      await poll();
    } catch (_) {
      // The poll reports its own failures; the schedule carries on.
    } finally {
      _inFlight = false;
    }
    _next();
  }
}

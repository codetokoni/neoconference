import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/chat_poller.dart';

class _FakeTimer implements Timer {
  _FakeTimer(this.after, this.callback);
  final Duration after;
  final void Function() callback;
  bool cancelled = false;

  void fire() {
    if (cancelled) return;
    cancelled = true; // a one-shot timer is spent once it has fired
    callback();
  }

  @override
  void cancel() => cancelled = true;
  @override
  bool get isActive => !cancelled;
  @override
  int get tick => 0;
}

void main() {
  test('the interval follows what the person can see', () {
    expect(chatPollInterval(chatOpen: true, visible: true),
        const Duration(seconds: 4));
    expect(chatPollInterval(chatOpen: false, visible: true),
        const Duration(seconds: 15));
    expect(chatPollInterval(chatOpen: false, visible: false),
        const Duration(seconds: 60));
  });

  late List<_FakeTimer> timers;
  late List<Completer<void>> polls;
  late ChatPoller poller;

  _FakeTimer live() => timers.lastWhere((t) => !t.cancelled);

  setUp(() {
    timers = [];
    polls = [];
    poller = ChatPoller(
      poll: () {
        final c = Completer<void>();
        polls.add(c);
        return c.future;
      },
      schedule: (after, cb) {
        final t = _FakeTimer(after, cb);
        timers.add(t);
        return t;
      },
    );
  });

  test('with the chat closed it polls every 15 s, not every 4', () {
    poller.start();
    expect(live().after, const Duration(seconds: 15));
  });

  test('opening the chat polls at once, then every 4 s', () async {
    poller.start();
    poller.chatOpen(true);
    expect(polls, hasLength(1), reason: 'the latest, not in up to 15 s');

    polls.single.complete();
    await pumpEventQueue();
    expect(live().after, const Duration(seconds: 4));
  });

  test('closing the chat slows it back down', () async {
    poller.start();
    poller.chatOpen(true);
    polls.single.complete();
    await pumpEventQueue();

    poller.chatOpen(false);
    expect(live().after, const Duration(seconds: 15));
  });

  test('in the background it polls once a minute, and catches up on return',
      () async {
    poller.start();
    poller.visible(false);
    expect(live().after, const Duration(seconds: 60));

    poller.visible(true);
    expect(polls, hasLength(1));
  });

  test('never starts a poll while one is still answering', () async {
    // A fixed 4 s timer did, and on a slow link they piled up.
    poller.start();
    live().fire();
    expect(polls, hasLength(1));

    poller.chatOpen(true); // would poll now, but one is in flight
    expect(polls, hasLength(1));
    expect(timers.where((t) => !t.cancelled), isEmpty,
        reason: 'nothing scheduled until the current poll answers');

    polls.single.complete();
    await pumpEventQueue();
    expect(live().after, const Duration(seconds: 4));
  });

  test('a failed poll does not stop the schedule', () async {
    poller.start();
    live().fire();
    polls.single.completeError(Exception('Connection reset by peer'));
    await pumpEventQueue();
    expect(live().after, const Duration(seconds: 15));
  });

  test('stop cancels everything', () {
    poller.start();
    poller.stop();
    for (final t in timers) {
      t.fire();
    }
    expect(polls, isEmpty);
  });
}

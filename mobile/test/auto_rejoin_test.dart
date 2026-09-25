import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/auto_rejoin.dart';

class _FakeTimer implements Timer {
  _FakeTimer(this.after, this.callback);
  final Duration after;
  final void Function() callback;
  bool cancelled = false;

  void fire() {
    if (!cancelled) callback();
  }

  @override
  void cancel() => cancelled = true;
  @override
  bool get isActive => !cancelled;
  @override
  int get tick => 0;
}

void main() {
  late DateTime now;
  late List<_FakeTimer> timers;
  late int attempts;
  late int expiries;
  late List<Completer<bool>> pending;
  late AutoRejoin rejoin;

  _FakeTimer lastLive() => timers.lastWhere((t) => !t.cancelled);

  setUp(() {
    now = DateTime(2026, 9, 25, 15);
    timers = [];
    attempts = 0;
    expiries = 0;
    pending = [];
    rejoin = AutoRejoin(
      attempt: () {
        attempts++;
        final c = Completer<bool>();
        pending.add(c);
        return c.future;
      },
      onExpired: () => expiries++,
      now: () => now,
      schedule: (after, callback) {
        final t = _FakeTimer(after, callback);
        timers.add(t);
        return t;
      },
    );
  });

  test('tries soon after the drop, and stops once back in', () async {
    rejoin.start();
    expect(timers.single.after, const Duration(seconds: 1));

    timers.single.fire();
    expect(attempts, 1);
    pending.single.complete(true);
    await pumpEventQueue();

    expect(rejoin.active, isFalse);
    expect(timers.where((t) => !t.cancelled && t != timers.first), isEmpty);
  });

  test('a failed try is followed by another after the interval', () async {
    rejoin.start();
    timers.single.fire();
    pending.single.complete(false);
    await pumpEventQueue();

    expect(rejoin.active, isTrue);
    expect(lastLive().after, const Duration(seconds: 5));
    lastLive().fire();
    expect(attempts, 2);
  });

  test('the network coming back tries at once, without waiting for the tick',
      () async {
    rejoin.start();
    timers.single.fire();
    pending.single.complete(false);
    await pumpEventQueue();
    final waiting = lastLive();

    rejoin.networkAvailable();
    expect(attempts, 2);
    expect(waiting.cancelled, isTrue, reason: 'no second try from the tick');
  });

  test('a network signal during an attempt does not start a second one',
      () async {
    rejoin.start();
    timers.single.fire();
    rejoin.networkAvailable();
    rejoin.networkAvailable();
    expect(attempts, 1);
  });

  test('gives up after the window and hands back to the Rejoin button',
      () async {
    rejoin.start();
    timers.single.fire();
    now = now.add(const Duration(minutes: 6));
    pending.single.complete(false);
    await pumpEventQueue();

    expect(expiries, 1);
    expect(rejoin.active, isFalse);
    // Nothing left scheduled: a pocketed phone must not rejoin later.
    expect(timers.where((t) => !t.cancelled && t != timers.first), isEmpty);
  });

  test('the network returning after the window does nothing', () async {
    rejoin.start();
    now = now.add(const Duration(minutes: 6));
    timers.single.fire();
    await pumpEventQueue();
    expect(attempts, 0);
    expect(expiries, 1);

    rejoin.networkAvailable();
    expect(attempts, 0);
  });

  test('stop cancels what is pending', () async {
    rejoin.start();
    rejoin.stop();
    timers.single.fire();
    expect(attempts, 0);
  });
}

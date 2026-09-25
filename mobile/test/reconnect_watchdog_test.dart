import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/reconnect_watchdog.dart';

class _FakeTimer implements Timer {
  _FakeTimer(this.callback);
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
  late int giveUps;
  late List<_FakeTimer> timers;
  late ReconnectWatchdog dog;

  setUp(() {
    giveUps = 0;
    timers = [];
    dog = ReconnectWatchdog(
      onGiveUp: () => giveUps++,
      schedule: (_, callback) {
        final t = _FakeTimer(callback);
        timers.add(t);
        return t;
      },
    );
  });

  test('a reconnect that never finishes is given up on', () {
    dog.reconnecting();
    timers.single.fire();
    expect(giveUps, 1);
    expect(dog.waiting, isFalse);
  });

  test('a reconnect that finishes in time is not', () {
    dog.reconnecting();
    dog.settled();
    timers.single.fire();
    expect(giveUps, 0);
  });

  test('repeated reconnecting reports do not restart the clock', () {
    // LiveKit sends both "reconnecting" and "resuming" for one outage. If
    // each restarted the clock, a link that flaps would never be given up.
    dog.reconnecting();
    dog.reconnecting();
    expect(timers, hasLength(1));
  });

  test('a second outage gets a fresh clock', () {
    dog.reconnecting();
    dog.settled();
    dog.reconnecting();
    expect(timers, hasLength(2));
    timers.last.fire();
    expect(giveUps, 1);
  });

  test('dispose stops a pending give-up', () {
    dog.reconnecting();
    dog.dispose();
    timers.single.fire();
    expect(giveUps, 0);
  });
}

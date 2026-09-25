import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:neoconference/src/room/weak_link.dart';

/// A timer that fires only when the test says so.
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
  late List<bool> changes;
  late List<_FakeTimer> timers;
  late WeakLinkPolicy policy;

  setUp(() {
    changes = [];
    timers = [];
    policy = WeakLinkPolicy(
      onChange: changes.add,
      schedule: (_, callback) {
        final timer = _FakeTimer(callback);
        timers.add(timer);
        return timer;
      },
    );
  });

  test('a good link says nothing', () {
    policy.report(ConnectionQuality.excellent);
    policy.report(ConnectionQuality.good);
    expect(changes, isEmpty);
    expect(timers, isEmpty);
  });

  test('poor turns weak on at once, and only once', () {
    policy.report(ConnectionQuality.poor);
    policy.report(ConnectionQuality.lost);
    expect(changes, [true]);
    expect(policy.weak, isTrue);
  });

  test('recovery clears weak only after the settle time', () {
    policy.report(ConnectionQuality.poor);
    policy.report(ConnectionQuality.good);
    expect(changes, [true], reason: 'still weak until the timer fires');
    expect(timers, hasLength(1));

    timers.single.fire();
    expect(changes, [true, false]);
    expect(policy.weak, isFalse);
  });

  test('dipping again before it settles keeps it weak, without flicker', () {
    policy.report(ConnectionQuality.poor);
    policy.report(ConnectionQuality.good);
    policy.report(ConnectionQuality.poor);
    expect(timers.single.cancelled, isTrue);

    timers.single.fire();
    expect(changes, [true]);
    expect(policy.weak, isTrue);
  });

  test('repeated good reports while settling start one timer, not several',
      () {
    policy.report(ConnectionQuality.poor);
    policy.report(ConnectionQuality.good);
    policy.report(ConnectionQuality.excellent);
    expect(timers, hasLength(1));
  });

  test('unknown is not taken as recovery', () {
    policy.report(ConnectionQuality.poor);
    policy.report(ConnectionQuality.unknown);
    expect(timers, isEmpty);
    expect(policy.weak, isTrue);
  });

  test('dispose cancels a pending clear', () {
    policy.report(ConnectionQuality.poor);
    policy.report(ConnectionQuality.good);
    policy.dispose();
    timers.single.fire();
    expect(changes, [true]);
  });
}

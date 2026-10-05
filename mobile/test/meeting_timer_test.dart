import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/room/meeting_timer.dart';

/// Asked for: the app had no meeting timer for an owner or host to set,
/// and nobody on a phone saw the one set on the website. The rules are the
/// server's (src/lib/timer.ts), copied.
void main() {
  const now = 1000000000;

  MeetingTimerState? parse(Map<String, Object?> json) => MeetingTimerState.fromJson(json);

  test('reads the server\'s state', () {
    final t = parse({
      'status': 'running',
      'durationMs': 600000,
      'remainingAtStartMs': 600000,
      'startedAtMs': now - 61000,
      'remainingAtPauseMs': null,
      'visibility': 'admins',
      'updatedAt': 5,
    })!;
    expect(t.running, isTrue);
    expect(t.adminsOnly, isTrue);
    expect(t.remainingMs(now), 539000);
    expect(MeetingTimerState.fromJson(null), isNull);
    expect(MeetingTimerState.fromJson({'nope': 1}), isNull);
  });

  test('remaining time follows the status, as computeRemaining does', () {
    expect(parse({'status': 'paused', 'durationMs': 600000, 'remainingAtStartMs': 600000, 'remainingAtPauseMs': 125000})!.remainingMs(now), 125000);
    expect(parse({'status': 'expired', 'durationMs': 600000, 'remainingAtStartMs': 0})!.remainingMs(now), 0);
    expect(parse({'status': 'idle', 'durationMs': 300000, 'remainingAtStartMs': 300000})!.remainingMs(now), 300000);
    // Ran out between polls: never negative.
    expect(parse({'status': 'running', 'durationMs': 60000, 'remainingAtStartMs': 60000, 'startedAtMs': now - 90000})!.remainingMs(now), 0);
  });

  test('the header says what everyone needs, and respects "only hosts"', () {
    final running = parse({'status': 'running', 'durationMs': 600000, 'remainingAtStartMs': 600000, 'startedAtMs': now - 1000})!;
    expect(timerLabel(running, manager: false, now: now), '09:59 left');
    final paused = parse({'status': 'paused', 'durationMs': 600000, 'remainingAtStartMs': 600000, 'remainingAtPauseMs': 300000})!;
    expect(timerLabel(paused, manager: false, now: now), '05:00 paused');
    expect(timerLabel(parse({'status': 'expired', 'durationMs': 60000, 'remainingAtStartMs': 0}), manager: false, now: now), "Time's up");
    expect(timerLabel(MeetingTimerState.idle, manager: true, now: now), isNull);

    final hostsOnly = parse({'status': 'running', 'durationMs': 600000, 'remainingAtStartMs': 600000, 'startedAtMs': now, 'visibility': 'admins'})!;
    expect(timerLabel(hostsOnly, manager: false, now: now), isNull);
    expect(timerLabel(hostsOnly, manager: true, now: now), '10:00 left');
  });

  test('the last stretch is urgent: 30 s, or a tenth of a long timer', () {
    final short = parse({'status': 'running', 'durationMs': 120000, 'remainingAtStartMs': 120000, 'startedAtMs': now - 95000})!;
    expect(short.urgent(now), isTrue); // 25 s left of 2 min
    final long = parse({'status': 'running', 'durationMs': 3600000, 'remainingAtStartMs': 3600000, 'startedAtMs': now - 3300000})!;
    expect(long.urgent(now), isTrue); // 5 min left of an hour (< 6 min)
    final early = parse({'status': 'running', 'durationMs': 3600000, 'remainingAtStartMs': 3600000, 'startedAtMs': now})!;
    expect(early.urgent(now), isFalse);
  });

  test('clock past an hour', () {
    expect(timerClock(3725000), '1:02:05');
    expect(timerClock(59001), '01:00');
  });
}

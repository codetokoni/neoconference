import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/meetings/meeting_board.dart';
import 'package:neoconference/src/meetings/meeting_view.dart';
import 'package:neoconference/src/meetings/when.dart';

/// Sorting the dashboard.
///
/// Written from what the real account actually returned: meetings from
/// 56 to 128 days ago, several still marked `live` because nothing closes
/// a room when the last person leaves. The first build put all of them
/// under "Upcoming", which is how a four-month-old meeting ended up
/// presented as the next thing happening.
void main() {
  final now = DateTime(2026, 9, 24, 18, 56);

  NeoEvent event({
    required String slug,
    required String state,
    DateTime? scheduledAt,
    DateTime? startedAt,
    DateTime? endedAt,
    DateTime? updatedAt,
    bool permanent = false,
  }) =>
      NeoEvent(
        id: slug,
        slug: slug,
        name: slug,
        state: state,
        isPermanent: permanent,
        isLocked: false,
        waitingRoomEnabled: false,
        scheduledAt: scheduledAt,
        startedAt: startedAt,
        endedAt: endedAt,
        updatedAt: updatedAt,
      );

  test('a meeting whose time has passed is not upcoming', () {
    final board = boardFromEvents([
      event(
        slug: 'netaccess',
        state: 'scheduled',
        scheduledAt: now.subtract(const Duration(days: 85)),
      ),
    ], now: now);

    expect(board.upcoming, isEmpty, reason: '85 days ago is not upcoming');
    expect(board.recent.map((m) => m.code), ['netaccess']);
  });

  test('a room live since months ago is an open room, not upcoming', () {
    final board = boardFromEvents([
      event(
        slug: 'orbit-o03c',
        state: 'live',
        startedAt: now.subtract(const Duration(days: 128)),
      ),
    ], now: now);

    expect(board.upcoming, isEmpty);
    expect(board.openRooms.map((m) => m.code), ['orbit-o03c']);
    // Still joinable — it really is open, and saying otherwise would be
    // its own kind of lie.
    expect(board.openRooms.single.canJoin, isTrue);
  });

  test('a room live since this morning is still today\'s meeting', () {
    final board = boardFromEvents([
      event(
        slug: 'standup',
        state: 'live',
        startedAt: now.subtract(const Duration(minutes: 20)),
      ),
    ], now: now);

    expect(board.openRooms, isEmpty);
    expect(board.upcoming.map((m) => m.code), ['standup']);
  });

  test('nothing stale is promoted to the next-up card', () {
    // The screen that started this: every meeting months old, one of them
    // still live, and the dashboard leading with "Live now · 128 days ago".
    final board = boardFromEvents([
      event(
        slug: 'aurora-viip',
        state: 'live',
        startedAt: now.subtract(const Duration(days: 128)),
      ),
      event(
        slug: 'road',
        state: 'scheduled',
        scheduledAt: now.subtract(const Duration(days: 68)),
      ),
    ], now: now);

    expect(board.next, isNull);
    expect(board.isEmpty, isFalse, reason: 'it still has things to show');
  });

  test('a genuinely upcoming meeting leads, ahead of an open room', () {
    final board = boardFromEvents([
      event(
        slug: 'stale',
        state: 'live',
        startedAt: now.subtract(const Duration(days: 40)),
      ),
      event(
        slug: 'soon',
        state: 'scheduled',
        scheduledAt: now.add(const Duration(minutes: 18)),
      ),
    ], now: now);

    expect(board.next?.code, 'soon');
    expect(board.next?.status, MeetingStatus.startingSoon);
    expect(board.openRooms.map((m) => m.code), ['stale']);
  });

  test('the personal room is kept out of the dated lists', () {
    final board = boardFromEvents([
      event(
        slug: 'victor4christ',
        state: 'ended',
        permanent: true,
        startedAt: now.subtract(const Duration(days: 6)),
      ),
    ], now: now);

    expect(board.personalRoom?.code, 'victor4christ');
    expect(board.recent, isEmpty);
    expect(board.upcoming, isEmpty);
    expect(board.personalRoom?.recurring, isTrue);
  });

  test('upcoming meetings are ordered by when they start', () {
    final board = boardFromEvents([
      event(
        slug: 'later',
        state: 'scheduled',
        scheduledAt: now.add(const Duration(hours: 4)),
      ),
      event(
        slug: 'sooner',
        state: 'scheduled',
        scheduledAt: now.add(const Duration(minutes: 30)),
      ),
    ], now: now);

    expect(board.upcoming.map((m) => m.code), ['sooner', 'later']);
  });

  test('recent is newest first', () {
    final board = boardFromEvents([
      event(
        slug: 'older',
        state: 'ended',
        startedAt: now.subtract(const Duration(days: 30)),
      ),
      event(
        slug: 'newer',
        state: 'ended',
        startedAt: now.subtract(const Duration(days: 2)),
      ),
    ], now: now);

    expect(board.recent.map((m) => m.code), ['newer', 'older']);
  });

  test('a reopened meeting is dated by when it last ran, not its first start', () {
    // startedAt is kept through a reopen. testneo, used an hour ago, read
    // "3 days ago" and sorted below meetings that really were older.
    final board = boardFromEvents([
      event(
        slug: 'reopened',
        state: 'ended',
        startedAt: now.subtract(const Duration(days: 3)),
        endedAt: now.subtract(const Duration(hours: 1)),
      ),
      event(
        slug: 'yesterday',
        state: 'ended',
        startedAt: now.subtract(const Duration(days: 1, hours: 2)),
        endedAt: now.subtract(const Duration(days: 1)),
      ),
    ], now: now);

    expect(board.recent.map((m) => m.code), ['reopened', 'yesterday']);
    expect(board.recent.first.startsAt, now.subtract(const Duration(hours: 1)));
    // The id travels with it, so the app can ask the server to reopen it.
    expect(board.recent.first.eventId, 'reopened');
    expect(board.recent.first.canJoin, isTrue);
  });

  test("a meeting reopened today is today's, not a stale open room", () {
    // startedAt keeps the first start through a reopen; updatedAt moves.
    final board = boardFromEvents([
      event(
        slug: 'reopened-live',
        state: 'live',
        startedAt: now.subtract(const Duration(days: 1, hours: 2)),
        updatedAt: now.subtract(const Duration(minutes: 10)),
      ),
      event(
        slug: 'forgotten-live',
        state: 'live',
        startedAt: now.subtract(const Duration(days: 60)),
        updatedAt: now.subtract(const Duration(days: 60)),
      ),
    ], now: now);

    expect(board.openRooms.map((m) => m.code), ['forgotten-live']);
    expect(board.upcoming.map((m) => m.code), contains('reopened-live'));
    final reopened = board.upcoming.firstWhere((m) => m.code == 'reopened-live');
    expect(reopened.startsAt, now.subtract(const Duration(minutes: 10)));
  });

  group('a phone whose clock runs behind the server', () {
    // Seen on the emulator after a cold boot, two minutes slow: a meeting
    // ended a moment ago sat under Recent as "in 2 min".
    final ahead = now.add(const Duration(minutes: 2));

    test('never shows a meeting that ended as in the future', () {
      final m = meetingFromEvent(
        event(slug: 'just-ended', state: 'ended', startedAt: now.subtract(const Duration(hours: 1)), endedAt: ahead),
        now: now,
      );
      expect(m.startsAt, now);
      expect(neoWhen(m.startsAt!, now: now), isNot(startsWith('in ')));
      expect(m.status, MeetingStatus.ended);
    });

    test('nor a meeting that just started', () {
      final m = meetingFromEvent(event(slug: 'just-live', state: 'live', startedAt: ahead), now: now);
      expect(m.startsAt, now);
    });

    test('but a scheduled time still lies ahead', () {
      final m = meetingFromEvent(event(slug: 'later', state: 'scheduled', scheduledAt: ahead), now: now);
      expect(m.startsAt, ahead);
      expect(neoWhen(m.startsAt!, now: now), 'in 2 min');
    });
  });
}

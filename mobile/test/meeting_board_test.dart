import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/meetings/meeting_board.dart';
import 'package:neoconference/src/meetings/meeting_view.dart';

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
}

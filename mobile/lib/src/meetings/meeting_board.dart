import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../events/event.dart';
import 'meeting_view.dart';

/// What the dashboard reads.
///
/// Declared here with no implementation so the screens can depend on it
/// without depending on either source. lib/main.dart overrides it with
/// [realMeetingBoard]; lib/main_showcase.dart overrides it with sample
/// data. A screen that forgets to be given one fails loudly at startup
/// rather than quietly showing an empty dashboard.
final meetingBoardProvider = FutureProvider<MeetingBoard>((ref) {
  throw UnimplementedError(
    'meetingBoardProvider must be overridden by the entrypoint',
  );
});

/// Load the dashboard again — from the network, not from a cached failure.
///
/// Invalidating [meetingBoardProvider] alone is not enough when the board
/// is built from other providers: it re-runs, awaits them, and they still
/// hold the first error. On a real phone one dropped connection left the
/// dashboard on "Could not load your meetings" until the app was
/// restarted, and Try again replayed the same failure every time. The
/// entrypoint knows what the board is built from, so it says how to
/// reload it.
final reloadMeetingBoardProvider = Provider<void Function()>(
  (ref) => () => ref.invalidate(meetingBoardProvider),
);

/// The real one: the signed-in account's meetings, from /api/events/mine.
final realMeetingBoard = FutureProvider<MeetingBoard>((ref) async {
  final events = await ref.watch(eventsProvider.future);
  return boardFromEvents(events, now: DateTime.now());
});

/// What lib/main.dart installs so the dashboard reads the real account.
///
/// A function rather than inline in main so a test can build the app's
/// exact wiring instead of a copy of it.
List<Override> realMeetingBoardOverrides() => [
      meetingBoardProvider
          .overrideWith((ref) => ref.watch(realMeetingBoard.future)),
      // The bottom of the chain. The board and its wrapper watch it, so
      // they rebuild from the fresh fetch on their own.
      reloadMeetingBoardProvider
          .overrideWith((ref) => () => ref.invalidate(eventsProvider)),
    ];

/// How long a room may sit "live" before the dashboard stops treating it
/// as something that is happening.
///
/// Meetings on this account are still marked live months after they
/// finished, because nothing closes them when the last person leaves. The
/// app cannot fix that, but it can stop repeating it: past this window a
/// live room is shown as an open room rather than as today's meeting.
/// Twelve hours is longer than any meeting anyone schedules and short
/// enough to catch the ones that were simply never closed.
const staleAfter = Duration(hours: 12);

/// Sorts the account's meetings into what the dashboard shows.
///
/// Upcoming means upcoming: a meeting whose time has passed goes to
/// recent or, if the server still has it open, to the open rooms. Anything
/// without a time sorts last rather than being dropped — a meeting with no
/// `scheduledAt` is still a meeting.
MeetingBoard boardFromEvents(List<NeoEvent> events, {required DateTime now}) {
  MeetingView? personal;
  final upcoming = <MeetingView>[];
  final openRooms = <MeetingView>[];
  final recent = <MeetingView>[];

  for (final e in events) {
    final view = meetingFromEvent(e, now: now);
    final started = view.startsAt;
    final past = started != null && started.isBefore(now);

    if (e.isPermanent && personal == null) {
      personal = view;
    } else if (view.isPast) {
      recent.add(view);
    } else if (view.isLive && past && now.difference(started).compareTo(staleAfter) > 0) {
      openRooms.add(view);
    } else if (past && !view.isLive) {
      // Scheduled, and the time went by. It did not become upcoming again.
      recent.add(view);
    } else {
      upcoming.add(view);
    }
  }

  int byWhen(MeetingView a, MeetingView b) {
    if (a.isLive != b.isLive) return a.isLive ? -1 : 1;
    final at = a.startsAt;
    final bt = b.startsAt;
    if (at == null && bt == null) return 0;
    if (at == null) return 1;
    if (bt == null) return -1;
    return at.compareTo(bt);
  }

  upcoming.sort(byWhen);
  // Most recently opened first — the one somebody is most likely to want.
  openRooms.sort((a, b) {
    final at = a.startsAt;
    final bt = b.startsAt;
    if (at == null || bt == null) return 0;
    return bt.compareTo(at);
  });
  // Most recently finished first, which is the one someone is looking for.
  recent.sort((a, b) {
    final at = a.startsAt;
    final bt = b.startsAt;
    if (at == null && bt == null) return 0;
    if (at == null) return 1;
    if (bt == null) return -1;
    return bt.compareTo(at);
  });

  return MeetingBoard(
    upcoming: upcoming,
    recent: recent,
    openRooms: openRooms,
    personalRoom: personal,
  );
}

MeetingView meetingFromEvent(NeoEvent e, {required DateTime now}) {
  final when = e.startedAt ?? e.scheduledAt;
  return MeetingView(
    title: e.name,
    code: e.slug,
    status: _status(e, when, now),
    canJoin: e.canJoin,
    startsAt: when,
    recurring: e.isPermanent,
    waitingRoom: e.waitingRoomEnabled,
    locked: e.isLocked,
    // Host, duration, participants and languages are not in the projection
    // /api/events/mine returns, so they stay unset and the screens leave
    // those parts out rather than inventing them.
  );
}

MeetingStatus _status(NeoEvent e, DateTime? when, DateTime now) {
  if (e.state == 'live' || e.state == 'waiting') return MeetingStatus.live;
  if (e.state == 'ended' || e.state == 'archived' || e.state == 'replay') {
    return MeetingStatus.ended;
  }
  if (when != null) {
    final until = when.difference(now);
    if (until.inMinutes <= 30 && !until.isNegative) {
      return MeetingStatus.startingSoon;
    }
  }
  return MeetingStatus.scheduled;
}

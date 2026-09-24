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

/// The real one: the signed-in account's meetings, from /api/events/mine.
final realMeetingBoard = FutureProvider<MeetingBoard>((ref) async {
  final events = await ref.watch(eventsProvider.future);
  return boardFromEvents(events, now: DateTime.now());
});

/// Sorts the account's meetings into what the dashboard shows.
///
/// Live first among the upcoming, then by start time: someone opening the
/// app during a meeting wants that meeting, not the one at four o'clock.
/// Anything without a time sorts last rather than being dropped — a
/// meeting with no `scheduledAt` is still a meeting.
MeetingBoard boardFromEvents(List<NeoEvent> events, {required DateTime now}) {
  MeetingView? personal;
  final upcoming = <MeetingView>[];
  final recent = <MeetingView>[];

  for (final e in events) {
    final view = meetingFromEvent(e, now: now);
    if (e.isPermanent && personal == null) {
      personal = view;
    } else if (view.isPast) {
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

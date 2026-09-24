import 'package:flutter/foundation.dart';

/// What a screen needs to know about a meeting to draw it.
///
/// The designed screens were built against sample data. Rather than keep a
/// second copy of every layout for the real app, the screens take this and
/// both sides map into it: production from [NeoEvent], the showcase from
/// lib/src/mock/sample_data.dart. One set of screens, two sources.
///
/// Fields the server does not send are nullable rather than invented.
/// `/api/events/mine` has no host name, no duration and no participant
/// list, so a real meeting renders without them and the design degrades to
/// what is true instead of showing a plausible-looking lie.
@immutable
class MeetingView {
  const MeetingView({
    required this.title,
    required this.code,
    required this.status,
    required this.canJoin,
    this.host,
    this.startsAt,
    this.durationMinutes,
    this.participants = const [],
    this.participantCount,
    this.recurring = false,
    this.hasRecording = false,
    this.languages = const [],
    this.waitingRoom = false,
    this.locked = false,
  });

  final String title;

  /// The slug. What someone types or pastes to join.
  final String code;

  final MeetingStatus status;
  final bool canJoin;

  final String? host;
  final DateTime? startsAt;
  final int? durationMinutes;

  /// Names, where they are known. Empty is normal for a real meeting.
  final List<String> participants;

  /// Where a count is known but the names are not.
  final int? participantCount;

  final bool recurring;
  final bool hasRecording;
  final List<String> languages;
  final bool waitingRoom;
  final bool locked;

  bool get isLive => status == MeetingStatus.live;
  bool get isPast => status == MeetingStatus.ended;

  /// Null when the server did not say, so callers can omit the row rather
  /// than print a zero.
  int? get knownParticipants =>
      participants.isNotEmpty ? participants.length : participantCount;
}

enum MeetingStatus { live, startingSoon, scheduled, ended }

/// The lists the dashboard shows.
@immutable
class MeetingBoard {
  const MeetingBoard({
    required this.upcoming,
    required this.recent,
    this.openRooms = const [],
    this.personalRoom,
  });

  const MeetingBoard.empty()
      : upcoming = const [],
        recent = const [],
        openRooms = const [],
        personalRoom = null;

  /// Meetings that have not happened yet.
  final List<MeetingView> upcoming;

  final List<MeetingView> recent;

  /// Rooms the server still reports as live, but which started long enough
  /// ago that calling them "upcoming" would be a lie.
  ///
  /// They are real and still joinable, so they are shown — under a heading
  /// that says what they are rather than under Upcoming, where a meeting
  /// from four months ago has no business being.
  final List<MeetingView> openRooms;

  /// A permanent room is always joinable and is not really "upcoming", so
  /// it gets its own place rather than sitting at the top of a list of
  /// things with start times.
  final MeetingView? personalRoom;

  /// What the dashboard leads with.
  ///
  /// A genuinely upcoming meeting first, then a room that went live
  /// recently. A stale room is deliberately not promoted: a card reading
  /// "Live now" above "128 days ago" is a contradiction, and leading the
  /// screen with it buries whatever is actually next.
  MeetingView? get next {
    if (upcoming.isNotEmpty) return upcoming.first;
    return null;
  }

  bool get isEmpty =>
      upcoming.isEmpty &&
      recent.isEmpty &&
      openRooms.isEmpty &&
      personalRoom == null;
}

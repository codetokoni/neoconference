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

/// The three lists the dashboard shows.
@immutable
class MeetingBoard {
  const MeetingBoard({
    required this.upcoming,
    required this.recent,
    this.personalRoom,
  });

  const MeetingBoard.empty()
      : upcoming = const [],
        recent = const [],
        personalRoom = null;

  final List<MeetingView> upcoming;
  final List<MeetingView> recent;

  /// A permanent room is always joinable and is not really "upcoming", so
  /// it gets its own place rather than sitting at the top of a list of
  /// things with start times.
  final MeetingView? personalRoom;

  /// What the dashboard leads with: whatever is live, else the soonest.
  MeetingView? get next {
    for (final m in upcoming) {
      if (m.isLive) return m;
    }
    return upcoming.isNotEmpty ? upcoming.first : null;
  }

  bool get isEmpty =>
      upcoming.isEmpty && recent.isEmpty && personalRoom == null;
}

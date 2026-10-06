import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_timezone/flutter_timezone.dart';

import '../core/api_client.dart';
import 'groups_api.dart';

/// A group's meetings, as `GET /api/groups/<id>/meetings` lists them
/// (MeetingListItem in src/lib/groupMeetings.ts).
@immutable
class GroupMeeting {
  const GroupMeeting({
    required this.id,
    required this.slug,
    required this.title,
    required this.state,
    required this.kind,
    this.description = '',
    this.start,
    this.durationMin = 60,
    this.timezone = 'UTC',
    this.seriesId,
    this.invitedCount = 0,
    this.attendedCount,
    this.hasPassword = false,
    this.waitingRoom = true,
    this.createdBy = '',
  });

  final String id;
  final String slug;
  final String title;

  /// scheduled | waiting | live | ended | replay | archived
  final String state;

  /// "scheduled" (the whole group, at a time), "now" (the whole group, at
  /// once) or "call" (chosen members).
  final String kind;
  final String description;
  final DateTime? start;
  final int durationMin;
  final String timezone;

  /// Set when it is one of a repeating series.
  final String? seriesId;
  final int invitedCount;

  /// Past meetings only.
  final int? attendedCount;
  final bool hasPassword;
  final bool waitingRoom;
  final String createdBy;

  bool get isLive => state == 'live' || state == 'waiting';
  bool get isCall => kind == 'call';

  /// Edit and Cancel are only for a meeting that has not started.
  bool get editable => state == 'scheduled';
  bool get repeats => seriesId != null;

  /// Join shows while it is live, or from 15 minutes before it starts.
  bool joinableAt(DateTime now) =>
      isLive || (start != null && !now.isBefore(start!.subtract(const Duration(minutes: 15))));

  factory GroupMeeting.fromJson(Map<String, dynamic> j) => GroupMeeting(
        id: j['id'] as String? ?? '',
        slug: j['slug'] as String? ?? '',
        title: j['title'] as String? ?? '',
        state: j['state'] as String? ?? 'scheduled',
        kind: j['kind'] as String? ?? 'scheduled',
        description: j['description'] as String? ?? '',
        start: j['start'] is String ? DateTime.tryParse(j['start'] as String)?.toLocal() : null,
        durationMin: (j['durationMin'] as num?)?.toInt() ?? 60,
        timezone: j['timezone'] as String? ?? 'UTC',
        seriesId: j['seriesId'] as String?,
        invitedCount: (j['invitedCount'] as num?)?.toInt() ?? 0,
        attendedCount: (j['attendedCount'] as num?)?.toInt(),
        hasPassword: j['hasPassword'] == true,
        waitingRoom: j['waitingRoom'] != false,
        createdBy: j['createdBy'] as String? ?? '',
      );
}

@immutable
class MeetingsPage {
  const MeetingsPage(this.items, this.nextCursor);
  final List<GroupMeeting> items;

  /// Ask again with this for more; null when there is no more. A page can
  /// be short (private calls you were not in are left out) and still have
  /// a next one.
  final int? nextCursor;
}

/// How a scheduled meeting repeats.
@immutable
class Recurrence {
  const Recurrence({required this.freq, this.interval = 1, this.byWeekday = const [], this.count, this.until});

  /// daily | weekly | monthly
  final String freq;
  final int interval;

  /// Weekly only: 0 = Sunday … 6 = Saturday, in the meeting's timezone.
  final List<int> byWeekday;

  /// End after this many meetings…
  final int? count;

  /// …or on this day (`YYYY-MM-DD`).
  final String? until;

  Map<String, dynamic> toJson() => {
        'freq': freq,
        'interval': interval,
        if (freq == 'weekly' && byWeekday.isNotEmpty) 'byWeekday': byWeekday,
        'count': ?count,
        'until': ?until,
      };
}

/// What a meeting is, as the schedule form fills it in.
@immutable
class MeetingDraft {
  const MeetingDraft({
    required this.title,
    this.description = '',
    required this.start,
    this.durationMin = 60,
    this.password,
    this.waitingRoom = true,
    this.extraEmails = const [],
    this.recurrence,
  });

  final String title;
  final String description;
  final DateTime start;
  final int durationMin;

  /// Null leaves it as it is (on an edit); empty clears it.
  final String? password;
  final bool waitingRoom;
  final List<String> extraEmails;
  final Recurrence? recurrence;
}

/// The phone's timezone as an IANA name ("Africa/Lagos"), which the server
/// uses to word times and to keep a repeating meeting at the same clock
/// time across daylight-saving changes. Replaced in tests.
Future<String> Function() deviceTimezone = () async {
  try {
    final tz = await FlutterTimezone.getLocalTimezone();
    return tz.identifier.isEmpty ? 'UTC' : tz.identifier;
  } catch (e) {
    debugPrint('[groups] timezone: $e');
    return 'UTC';
  }
};

class GroupMeetingsApi {
  const GroupMeetingsApi(this.api);
  final ApiClient api;

  static String _id(String id) => Uri.encodeComponent(id);

  Future<MeetingsPage> list(String groupId, {required bool past, int? cursor}) async {
    final body = await api.get('/api/groups/${_id(groupId)}/meetings', {
      'scope': past ? 'past' : 'upcoming',
      if (cursor != null) 'cursor': '$cursor',
    }) as Map;
    return MeetingsPage(
      [for (final m in (body['items'] as List? ?? const []).whereType<Map<String, dynamic>>()) GroupMeeting.fromJson(m)],
      (body['nextCursor'] as num?)?.toInt(),
    );
  }

  /// Schedules a meeting (or a series) for the whole group.
  Future<void> schedule(String groupId, MeetingDraft m) async {
    await api.post('/api/groups/${_id(groupId)}/meetings', {
      'mode': 'scheduled',
      'title': m.title,
      if (m.description.isNotEmpty) 'description': m.description,
      'scheduledAt': m.start.toUtc().toIso8601String(),
      'timezone': await deviceTimezone(),
      'durationMin': m.durationMin,
      if (m.password != null && m.password!.isNotEmpty) 'password': m.password,
      'waitingRoom': m.waitingRoom,
      if (m.extraEmails.isNotEmpty) 'extraEmails': m.extraEmails,
      if (m.recurrence != null) 'recurrence': m.recurrence!.toJson(),
    });
  }

  /// Starts a meeting of the whole group now; everyone is rung. Returns the
  /// slug to go in with.
  Future<String> startNow(String groupId, String title) async {
    final body = await api.post('/api/groups/${_id(groupId)}/meetings', {
      'mode': 'now',
      'title': title,
      'timezone': await deviceTimezone(),
    }) as Map;
    return body['slug'] as String? ?? '';
  }

  /// A private call with some members; they are rung. Returns the slug.
  Future<String> call(String groupId, List<String> userIds) async {
    final body = await api.post('/api/groups/${_id(groupId)}/calls', {
      'userIds': userIds,
      'timezone': await deviceTimezone(),
    }) as Map;
    return body['slug'] as String? ?? '';
  }

  /// Changes a scheduled meeting; [following] carries the change to the
  /// rest of its series.
  Future<void> update(String groupId, String eventId, MeetingDraft m, {bool following = false}) async {
    await api.patch('/api/groups/${_id(groupId)}/meetings/${_id(eventId)}', {
      'scope': following ? 'following' : 'this',
      'title': m.title,
      'description': m.description,
      'scheduledAt': m.start.toUtc().toIso8601String(),
      'durationMin': m.durationMin,
      'password': ?m.password,
      'waitingRoom': m.waitingRoom,
    });
  }

  Future<void> cancel(String groupId, String eventId, {bool following = false}) async {
    await api.delete(
      '/api/groups/${_id(groupId)}/meetings/${_id(eventId)}?scope=${following ? 'following' : 'this'}',
    );
  }
}

final groupMeetingsApiProvider = Provider<GroupMeetingsApi>((ref) => GroupMeetingsApi(ref.watch(groupsApiProvider).api));

/// Bumped when a group's page is reloaded, for what it keeps itself (the
/// pages of past meetings) rather than in a provider.
final groupRevisionProvider = StateProvider.autoDispose.family<int, String>((ref, groupId) => 0);

/// Live and coming up: live first, then soonest. Not paged.
final upcomingMeetingsProvider = FutureProvider.autoDispose.family<List<GroupMeeting>, String>((ref, groupId) async {
  return (await ref.watch(groupMeetingsApiProvider).list(groupId, past: false)).items;
});

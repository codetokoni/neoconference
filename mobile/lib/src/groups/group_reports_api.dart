import 'package:flutter/foundation.dart';

import '../core/api_client.dart';

DateTime? _iso(dynamic v) => v is String && v.isNotEmpty ? DateTime.tryParse(v)?.toLocal() : null;
DateTime? _ms(dynamic v) => v is num && v > 0 ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : null;
int _int(dynamic v) => v is num ? v.toInt() : 0;

/// A row of a group's reports (ReportListItem, src/lib/groupReports.ts).
@immutable
class ReportItem {
  const ReportItem({
    required this.eventId,
    required this.title,
    required this.kind,
    this.date,
    this.durationMin = 0,
    this.invited = 0,
    this.attended = 0,
    this.absent = 0,
  });

  final String eventId;
  final String title;
  final String kind;
  final DateTime? date;
  final int durationMin;
  final int invited;
  final int attended;
  final int absent;

  factory ReportItem.fromJson(Map<String, dynamic> j) => ReportItem(
        eventId: j['eventId'] as String? ?? '',
        title: j['title'] as String? ?? '',
        kind: j['kind'] as String? ?? 'scheduled',
        date: _iso(j['date']),
        durationMin: _int(j['durationMin']),
        invited: _int(j['invited']),
        attended: _int(j['attended']),
        absent: _int(j['absent']),
      );
}

@immutable
class ReportPerson {
  const ReportPerson({
    required this.name,
    required this.present,
    this.key = '',
    this.userId,
    this.invited = false,
    this.email = '',
    this.declined = false,
    this.joinedAt,
    this.leftAt,
    this.attendedMs = 0,
    this.entries = 0,
    this.callAttempts = 0,
    this.missedCalls = 0,
  });

  final String name;

  /// The report's key for them: an account id, a lowercased email,
  /// `kc:<handle>` for a KingsChat handle nobody has signed in with yet, or
  /// `name:<name>` for a guest.
  final String key;

  /// Their account, when they have one.
  final String? userId;
  final bool invited;
  final String email;
  final bool present;
  final bool declined;
  final DateTime? joinedAt;
  final DateTime? leftAt;
  final int attendedMs;
  final int entries;
  final int callAttempts;
  final int missedCalls;

  /// The KingsChat handle they were invited by, if that is all there is.
  String? get kcHandle => key.startsWith('kc:') ? key.substring(3) : null;

  /// Something a group can be given for them: an account, an email or a
  /// KingsChat handle. A guest known only by name has none.
  bool get addable => userId != null || email.isNotEmpty || kcHandle != null;

  factory ReportPerson.fromJson(Map<String, dynamic> j) => ReportPerson(
        name: j['name'] as String? ?? '',
        key: j['key'] as String? ?? '',
        userId: j['userId'] as String?,
        invited: j['invited'] == true,
        email: j['email'] as String? ?? '',
        present: j['status'] == 'present',
        declined: j['declined'] == true,
        joinedAt: _ms(j['joinedAt']),
        leftAt: _ms(j['leftAt']),
        attendedMs: _int(j['attendedMs']),
        entries: _int(j['entries']),
        callAttempts: _int(j['callAttempts']),
        missedCalls: _int(j['missedCalls']),
      );
}

/// One meeting's report (MeetingReport, src/lib/groupReports.ts).
@immutable
class MeetingReport {
  const MeetingReport({
    required this.eventId,
    required this.slug,
    required this.title,
    required this.groupName,
    required this.hosts,
    required this.people,
    this.scheduledStart,
    this.actualStart,
    this.actualEnd,
    this.durationMin = 0,
    this.invited = 0,
    this.attended = 0,
    this.absent = 0,
    this.firstToJoin,
    this.lastToLeave,
    this.callAttempts = 0,
    this.missedCalls = 0,
    this.recordingUrl,
    this.recorded = false,
    this.aiSummary,
    this.chatMessages = 0,
    this.inGroup = true,
  });

  final String eventId;
  final String slug;
  final String title;
  final String groupName;
  final List<String> hosts;
  final List<ReportPerson> people;
  final DateTime? scheduledStart;
  final DateTime? actualStart;
  final DateTime? actualEnd;
  final int durationMin;
  final int invited;
  final int attended;
  final int absent;
  final String? firstToJoin;
  final String? lastToLeave;
  final int callAttempts;
  final int missedCalls;

  /// `/replay/<slug>` when the replay is open to watch.
  final String? recordingUrl;
  final bool recorded;
  final String? aiSummary;
  final int chatMessages;

  /// A meeting of a group; false for any other meeting (History).
  final bool inGroup;

  factory MeetingReport.fromJson(Map<String, dynamic> j) {
    final s = j['summary'] is Map ? j['summary'] as Map : const {};
    final g = j['group'] is Map ? j['group'] as Map : const {};
    return MeetingReport(
      inGroup: j['group'] is Map,
      chatMessages: _int(s['chatMessages']),
      eventId: j['eventId'] as String? ?? '',
      slug: j['slug'] as String? ?? '',
      title: j['title'] as String? ?? '',
      groupName: g['name'] as String? ?? '',
      hosts: [for (final h in (j['hosts'] as List? ?? const [])) '$h'],
      people: [for (final p in (j['participants'] as List? ?? const []).whereType<Map<String, dynamic>>()) ReportPerson.fromJson(p)],
      scheduledStart: _iso(j['scheduledStart']),
      actualStart: _iso(j['actualStart']),
      actualEnd: _iso(j['actualEnd']),
      durationMin: _int(j['durationMin']),
      invited: _int(s['invited']),
      attended: _int(s['attended']),
      absent: _int(s['absent']),
      firstToJoin: s['firstToJoin'] as String?,
      lastToLeave: s['lastToLeave'] as String?,
      callAttempts: _int(s['totalCallAttempts']),
      missedCalls: _int(s['totalMissedCalls']),
      recordingUrl: s['recordingUrl'] as String?,
      recorded: s['recorded'] == true,
      aiSummary: s['aiSummary'] as String?,
    );
  }
}

/// One of your own finished group meetings (`/api/me/meetings`).
@immutable
class MyMeeting {
  const MyMeeting({
    required this.eventId,
    required this.title,
    required this.groupName,
    required this.present,
    this.date,
    this.durationMin = 0,
    this.attendedMs = 0,
    this.declined = false,
  });

  final String eventId;
  final String title;
  final String groupName;
  final bool present;
  final DateTime? date;
  final int durationMin;
  final int attendedMs;
  final bool declined;

  factory MyMeeting.fromJson(Map<String, dynamic> j) => MyMeeting(
        eventId: j['eventId'] as String? ?? '',
        title: j['title'] as String? ?? '',
        groupName: j['groupName'] as String? ?? '',
        present: j['status'] == 'present',
        date: _iso(j['date']),
        durationMin: _int(j['durationMin']),
        attendedMs: _int(j['attendedMs']),
        declined: j['declined'] == true,
      );
}

/// Your own part in one meeting (`/api/me/meetings/<eid>`).
@immutable
class MyMeetingDetail {
  const MyMeetingDetail({required this.meeting, required this.hosts, required this.me});

  final MyMeeting meeting;
  final List<String> hosts;
  final ReportPerson me;

  factory MyMeetingDetail.fromJson(Map<String, dynamic> j) {
    final m = j['meeting'] as Map<String, dynamic>;
    final me = m['me'] is Map<String, dynamic> ? m['me'] as Map<String, dynamic> : const <String, dynamic>{};
    return MyMeetingDetail(
      meeting: MyMeeting.fromJson({...m, 'status': me['status'], 'attendedMs': me['attendedMs'], 'declined': me['declined']}),
      hosts: [for (final h in (m['hosts'] as List? ?? const [])) '$h'],
      me: ReportPerson.fromJson(me),
    );
  }
}

/// A page of a list, with where to carry on; a page can be short and still
/// have more after it.
@immutable
class Page<T> {
  const Page(this.items, this.nextCursor);
  final List<T> items;
  final int? nextCursor;
}

/// A `YYYY-MM-DD` day, as the report routes take them.
String reportDay(DateTime d) =>
    '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// "1 h 05 min", "42 min", "under a minute".
String attendedText(int ms) {
  final min = ms ~/ 60000;
  if (min < 1) return ms > 0 ? 'under a minute' : '—';
  if (min < 60) return '$min min';
  return '${min ~/ 60} h ${(min % 60).toString().padLeft(2, '0')} min';
}

/// Any meeting's report (`/api/events/<id>/report`), for History: in a group
/// or not. Hosts and the owner of the meeting only, as its spreadsheet.
class EventReportsApi {
  const EventReportsApi(this.api);
  final ApiClient api;

  static String _id(String id) => Uri.encodeComponent(id);

  Future<MeetingReport> report(String eventId) async {
    final body = await api.get('/api/events/${_id(eventId)}/report') as Map;
    return MeetingReport.fromJson(body['report'] as Map<String, dynamic>);
  }

  /// The meeting's attendance spreadsheet.
  Future<({List<int> bytes, String filename, String mimeType})> xlsx(String eventId) =>
      api.getBytes('/api/events/${_id(eventId)}/attendance', fallbackName: 'attendance.xlsx');
}

class GroupReportsApi {
  const GroupReportsApi(this.api);
  final ApiClient api;

  static String _id(String id) => Uri.encodeComponent(id);

  Future<Page<ReportItem>> list(String groupId, {DateTime? from, DateTime? to, int? cursor}) async {
    final body = await api.get('/api/groups/${_id(groupId)}/reports', {
      if (from != null) 'from': reportDay(from),
      if (to != null) 'to': reportDay(to),
      if (cursor != null) 'cursor': '$cursor',
    }) as Map;
    return Page(
      [for (final i in (body['items'] as List? ?? const []).whereType<Map<String, dynamic>>()) ReportItem.fromJson(i)],
      (body['nextCursor'] as num?)?.toInt(),
    );
  }

  Future<MeetingReport> report(String groupId, String eventId) async {
    final body = await api.get('/api/groups/${_id(groupId)}/reports/${_id(eventId)}') as Map;
    return MeetingReport.fromJson(body['report'] as Map<String, dynamic>);
  }

  /// One meeting's spreadsheet (Hosts and the Owner).
  Future<({List<int> bytes, String filename, String mimeType})> reportXlsx(String groupId, String eventId) =>
      api.getBytes('/api/groups/${_id(groupId)}/reports/${_id(eventId)}', query: {'format': 'xlsx'}, fallbackName: 'report.xlsx');

  /// Every meeting between two days, one row per person per meeting.
  Future<({List<int> bytes, String filename, String mimeType})> rangeXlsx(String groupId, DateTime from, DateTime to) =>
      api.getBytes('/api/groups/${_id(groupId)}/reports/export',
          query: {'from': reportDay(from), 'to': reportDay(to)}, fallbackName: 'reports.xlsx');

  Future<Page<MyMeeting>> mine({int? cursor}) async {
    final body = await api.get('/api/me/meetings', {if (cursor != null) 'cursor': '$cursor'}) as Map;
    return Page(
      [for (final i in (body['items'] as List? ?? const []).whereType<Map<String, dynamic>>()) MyMeeting.fromJson(i)],
      (body['nextCursor'] as num?)?.toInt(),
    );
  }

  Future<MyMeetingDetail> myMeeting(String eventId) async {
    final body = await api.get('/api/me/meetings/${_id(eventId)}') as Map<String, dynamic>;
    return MyMeetingDetail.fromJson(body);
  }
}

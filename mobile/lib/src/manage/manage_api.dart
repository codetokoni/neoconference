import 'package:flutter/foundation.dart';

import '../core/api_client.dart';

/// Managing a meeting from the phone: the calls the web's meeting page
/// makes, against the same routes, so the phone and the dashboard can
/// never disagree about what a meeting is.

DateTime? _date(dynamic v) => v is String && v.isNotEmpty ? DateTime.tryParse(v)?.toLocal() : null;

/// A meeting as its owner manages it (`GET /api/events/<id>`).
@immutable
class ManagedMeeting {
  const ManagedMeeting({
    required this.id,
    required this.slug,
    required this.name,
    required this.state,
    required this.waitingRoomEnabled,
    required this.isPermanent,
    required this.endPinSet,
    this.description,
    this.scheduledAt,
    this.startedAt,
    this.endedAt,
  });

  final String id;
  final String slug;
  final String name;
  final String state;
  final bool waitingRoomEnabled;
  final bool isPermanent;
  final bool endPinSet;
  final String? description;
  final DateTime? scheduledAt;
  final DateTime? startedAt;
  final DateTime? endedAt;

  bool get isLive => state == 'live' || state == 'waiting';

  factory ManagedMeeting.fromJson(Map<String, dynamic> j) => ManagedMeeting(
        id: j['id'] as String? ?? '',
        slug: j['slug'] as String? ?? '',
        name: (j['name'] as String?)?.trim().isNotEmpty == true ? j['name'] as String : 'Untitled meeting',
        state: j['state'] as String? ?? 'scheduled',
        waitingRoomEnabled: j['waitingRoomEnabled'] == true,
        isPermanent: j['isPermanent'] == true,
        endPinSet: j['endPinSet'] == true,
        description: j['description'] as String?,
        scheduledAt: _date(j['scheduledAt']),
        startedAt: _date(j['startedAt']),
        endedAt: _date(j['endedAt']),
      );
}

/// Someone given a role by KingsChat handle.
@immutable
class HandleRole {
  const HandleRole(this.handle, this.role);
  final String handle;

  /// 'host' or 'moderator' (shown as Cohost, as on the web).
  final String role;

  String get label => role == 'host' ? 'Host' : role == 'moderator' ? 'Cohost' : role;
}

/// One of a meeting's recordings (GET /api/recordings?eventSlug=).
@immutable
class MeetingRecording {
  const MeetingRecording({
    required this.key,
    required this.size,
    this.recordedAt,
    this.downloadUrl,
    this.transcriptStatus,
    this.transcriptError,
  });

  final String key;
  final int size;
  final DateTime? recordedAt;
  final String? downloadUrl;

  /// queued | running | done | error, or null when never transcribed.
  final String? transcriptStatus;
  final String? transcriptError;

  bool get transcribed => transcriptStatus == 'done';

  /// The meeting it was recorded in, from its key:
  /// `recordings/<recorder>/<slug>/<timestamp>.mp4`.
  String? get slug {
    final parts = key.split('/');
    return parts.length >= 4 && parts.first == 'recordings' ? parts[parts.length - 2] : null;
  }

  factory MeetingRecording.fromJson(Map<String, dynamic> j) {
    final t = j['transcript'];
    return MeetingRecording(
      key: j['key'] as String? ?? '',
      size: (j['size'] as num?)?.toInt() ?? 0,
      recordedAt: _date(j['lastModified']),
      downloadUrl: j['downloadUrl'] as String?,
      transcriptStatus: t is Map ? t['status'] as String? : null,
      transcriptError: t is Map ? t['error'] as String? : null,
    );
  }
}

/// The calls, over the app's authenticated client.
class ManageApi {
  const ManageApi(this.api);
  final ApiClient api;

  Future<ManagedMeeting> meeting(String idOrSlug) async {
    final body = await api.get('/api/events/${Uri.encodeComponent(idOrSlug)}');
    return ManagedMeeting.fromJson((body as Map)['event'] as Map<String, dynamic>);
  }

  /// Rename, reschedule, or set or clear the End PIN (an empty [endPin]
  /// clears it). Only what is passed changes.
  Future<void> update(String id, {String? name, DateTime? scheduledAt, String? endPin}) async {
    await api.patch('/api/events/${Uri.encodeComponent(id)}', {
      'name': ?name,
      if (scheduledAt != null) 'scheduledAt': scheduledAt.toUtc().toIso8601String(),
      'endPin': ?endPin,
    });
  }

  Future<void> setWaitingRoom(String slug, bool enabled) async {
    await api.post('/api/waiting-room', {'op': 'set', 'slug': slug, 'enabled': enabled});
  }

  Future<List<HandleRole>> handleRoles(String id) async {
    final body = await api.get('/api/events/${Uri.encodeComponent(id)}/kc-invites');
    final items = (body is Map ? body['items'] : null) as List? ?? const [];
    return [
      for (final i in items.whereType<Map>())
        HandleRole(i['handle'] as String? ?? '', i['role'] as String? ?? ''),
    ];
  }

  /// Gives a KingsChat handle a role (host or moderator), sending them a
  /// KingsChat message when [message] and they have linked KingsChat.
  /// Says whether the message went, and if not, the server's reason
  /// (`recipient_never_signed_in`, `sender_not_linked`, `send_failed`).
  Future<({bool sent, String? reason})> addHandleRole(
    String id,
    String handle,
    String role, {
    bool message = true,
  }) async {
    final body = await api.post('/api/events/${Uri.encodeComponent(id)}/invite-kc', {
      'handle': handle,
      'role': role,
      'sendMessage': message,
    });
    return (
      sent: body is Map && body['sent'] == true,
      reason: body is Map ? body['sendReason'] as String? : null,
    );
  }

  Future<void> revokeHandleRole(String id, String handle) async {
    await api.delete('/api/events/${Uri.encodeComponent(id)}/kc-invites', {'handle': handle});
  }

  Future<List<MeetingRecording>> recordings({String? slug}) async {
    final body = await api.get('/api/recordings', {'eventSlug': ?slug});
    final list = (body is Map ? body['recordings'] : null) as List? ?? const [];
    return [for (final r in list.whereType<Map<String, dynamic>>()) MeetingRecording.fromJson(r)];
  }

  /// Starts a transcription. The meeting is read from the recording's key.
  Future<void> transcribe(String key) async {
    await api.post('/api/transcribe', {'recordingKey': key});
  }

  Future<String?> summary(String id) async {
    final body = await api.get('/api/events/${Uri.encodeComponent(id)}/summary');
    final s = body is Map ? body['summary'] : null;
    return s is Map ? s['text'] as String? : null;
  }

  Future<String?> generateSummary(String id) async {
    final body = await api.post('/api/events/${Uri.encodeComponent(id)}/summary');
    final s = body is Map ? body['summary'] : null;
    return s is Map ? s['text'] as String? : null;
  }

  /// Deletes the meeting for good. The server asks for the slug typed back.
  Future<void> delete(String slug) async {
    await api.post('/api/events/delete', {'slug': slug, 'confirm': slug, 'mode': 'delete'});
  }
}

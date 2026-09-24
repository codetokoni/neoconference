import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_controller.dart';
import '../core/api_client.dart';

/// One of the signed-in user's meetings, as /api/events/mine returns it.
@immutable
class NeoEvent {
  const NeoEvent({
    required this.id,
    required this.slug,
    required this.name,
    required this.state,
    required this.isPermanent,
    required this.isLocked,
    required this.waitingRoomEnabled,
    this.scheduledAt,
    this.startedAt,
  });

  final String id;
  final String slug;
  final String name;

  /// scheduled | waiting | live | ended | replay | archived
  final String state;
  final bool isPermanent;
  final bool isLocked;
  final bool waitingRoomEnabled;
  final DateTime? scheduledAt;
  final DateTime? startedAt;

  bool get isLive => state == 'live' || state == 'waiting';

  /// A permanent personal room is always joinable; a finished meeting is
  /// not something to walk back into.
  bool get canJoin => isPermanent || state != 'ended' && state != 'archived';

  static DateTime? _date(dynamic v) =>
      v is String && v.isNotEmpty ? DateTime.tryParse(v)?.toLocal() : null;

  factory NeoEvent.fromJson(Map<String, dynamic> json) => NeoEvent(
        id: json['id'] as String? ?? '',
        slug: json['slug'] as String? ?? '',
        name: (json['name'] as String?)?.trim().isNotEmpty == true
            ? json['name'] as String
            : 'Untitled meeting',
        state: json['state'] as String? ?? 'scheduled',
        isPermanent: json['isPermanent'] == true,
        isLocked: json['isLocked'] == true,
        waitingRoomEnabled: json['waitingRoomEnabled'] == true,
        scheduledAt: _date(json['scheduledAt']),
        startedAt: _date(json['startedAt']),
      );
}

final apiProvider = Provider<ApiClient>((ref) {
  final client = ApiClient(token: () => ref.read(authProvider.notifier).currentToken());
  ref.onDispose(client.close);
  return client;
});

/// The user's meetings. Watches auth so signing in or out refetches rather
/// than leaving the previous person's list on screen.
final eventsProvider = FutureProvider<List<NeoEvent>>((ref) async {
  final signedIn = ref.watch(authProvider.select((s) => s.sessionId));
  if (signedIn == null) return const [];

  final body = await ref.watch(apiProvider).get('/api/events/mine');
  final list = (body is Map ? body['events'] : null) as List? ?? const [];
  return list
      .whereType<Map<String, dynamic>>()
      .map(NeoEvent.fromJson)
      .toList(growable: false);
});

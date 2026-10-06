import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/api_client.dart';

/// "I'm in this meeting", every 60 seconds while connected, and "I left"
/// on the way out — what the web's PresenceHeartbeat sends
/// (`/api/me/presence`). The server's ringing reads it, so nobody is rung
/// into a meeting they are already in, or rung over another one.
class MeetingHeartbeat {
  MeetingHeartbeat._();

  static final instance = MeetingHeartbeat._();

  static const every = Duration(seconds: 60);

  /// The meeting this phone is in, or null.
  final current = ValueNotifier<String?>(null);

  Timer? _timer;
  ApiClient? _api;

  void start(ApiClient api, String slug) {
    if (current.value == slug && _timer != null) return;
    _timer?.cancel();
    _api = api;
    current.value = slug;
    _beat(slug);
    _timer = Timer.periodic(every, (_) => _beat(slug));
  }

  /// Stops beating for [slug]; a later meeting's heartbeat is left alone.
  void stop(String slug) {
    if (current.value != slug) return;
    _timer?.cancel();
    _timer = null;
    current.value = null;
    final api = _api;
    _api = null;
    if (api == null) return;
    unawaited(api.delete('/api/me/presence').then((_) {}, onError: (Object e) {
      debugPrint('[presence] leaving: $e');
    }));
  }

  void _beat(String slug) {
    final api = _api;
    if (api == null) return;
    unawaited(api.post('/api/me/presence', {'eventSlug': slug}).then((_) {}, onError: (Object e) {
      // A meeting that is not an event the server knows (404) has nothing
      // to say about ringing; anything else is tried again next beat.
      debugPrint('[presence] $slug: $e');
    }));
  }
}

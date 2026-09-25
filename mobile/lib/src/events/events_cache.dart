import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// The last meetings list the server gave this device, kept so the next
/// start can show it at once.
///
/// On the phone's Wi-Fi the list took 2.5–4.7 s to arrive, with a blank
/// placeholder the whole time, and it is almost always the same list as
/// last time. This is shown while the fresh one loads, and in place of an
/// error page when the fresh one cannot be had.
///
/// Stored with the session it belongs to and only read back for that
/// session, so one account never sees another's meetings. Signing out
/// wipes it.
class EventsCache {
  const EventsCache._();

  static const _key = 'neo.events.saved';

  /// Saves the raw `events` array from /api/events/mine.
  static Future<void> save(String sessionId, List<dynamic> events) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _key,
        jsonEncode({'session': sessionId, 'events': events}),
      );
    } catch (_) {
      // Not saving only costs the next start its head start.
    }
  }

  /// The saved array for this session, or null.
  static Future<List<Map<String, dynamic>>?> read(String sessionId) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null) return null;
      final saved = jsonDecode(raw);
      if (saved is! Map || saved['session'] != sessionId) return null;
      final events = saved['events'];
      if (events is! List) return null;
      return events.whereType<Map<String, dynamic>>().toList();
    } catch (_) {
      return null;
    }
  }

  static Future<void> clear() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_key);
    } catch (_) {}
  }
}

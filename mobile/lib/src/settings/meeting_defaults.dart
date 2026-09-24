import 'package:shared_preferences/shared_preferences.dart';

/// The join preferences, in one place.
///
/// The settings screen writes them and the room reads them, so they live
/// here rather than in either: two files each spelling the key their own way
/// is how a switch ends up moving nothing.
///
/// Both default to the quiet option. Arriving already broadcasting is a rude
/// surprise on a phone, which is likely to be somewhere personal, so the
/// default stays what the app did before this screen existed — and storage
/// failing falls back to the same answer rather than to a live microphone.
class MeetingDefaults {
  const MeetingDefaults._();

  static const joinMutedKey = 'neo.join.muted';
  static const joinCameraOffKey = 'neo.join.cameraOff';

  static Future<bool> joinMuted() => _read(joinMutedKey);

  static Future<bool> joinCameraOff() => _read(joinCameraOffKey);

  static Future<void> setJoinMuted(bool value) => _write(joinMutedKey, value);

  static Future<void> setJoinCameraOff(bool value) =>
      _write(joinCameraOffKey, value);

  static Future<bool> _read(String key) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(key) ?? true;
    } catch (_) {
      return true;
    }
  }

  static Future<void> _write(String key, bool value) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(key, value);
    } catch (_) {
      // Applied for this run even if the phone refuses to remember it.
    }
  }
}

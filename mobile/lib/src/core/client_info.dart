import 'dart:async';
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// Which app and phone this is, e.g. "android 1.2.4+5217 OPPO CPH2365 /
/// Android 14". Sent with every meeting join, so when people say "the app
/// keeps closing" the server's attendance journal can say which versions and
/// which phones. Null when the phone will not say.
Future<String?> clientDescription() => _description ??= _describe();
Future<String?>? _description;

Future<String?> _describe() async {
  if (kIsWeb) return null;
  try {
    final app = await PackageInfo.fromPlatform();
    var phone = '';
    if (Platform.isAndroid) {
      final a = await DeviceInfoPlugin().androidInfo;
      phone = '${a.manufacturer} ${a.model} / Android ${a.version.release}';
    } else if (Platform.isIOS) {
      final i = await DeviceInfoPlugin().iosInfo;
      phone = '${i.utsname.machine} / iOS ${i.systemVersion}';
    }
    return '${Platform.operatingSystem} ${app.version}+${app.buildNumber} $phone'.trim();
  } catch (e) {
    debugPrint('[client] $e');
    return null;
  }
}

/// Crash reports (Firebase Crashlytics, project neoconference-2e6a0): Dart
/// errors nobody caught, and Android's own crashes, with the meeting the
/// person was in. Release builds only; a phone without Google Play services
/// carries on without them.
class CrashReports {
  CrashReports._();

  static bool _on = false;

  static Future<void> start() async {
    if (kIsWeb || kDebugMode) return;
    try {
      await Firebase.initializeApp();
      final c = FirebaseCrashlytics.instance;
      await c.setCrashlyticsCollectionEnabled(true);
      FlutterError.onError = c.recordFlutterFatalError;
      PlatformDispatcher.instance.onError = (error, stack) {
        unawaited(c.recordError(error, stack, fatal: true));
        return true;
      };
      final client = await clientDescription();
      if (client != null) await c.setCustomKey('client', client);
      _on = true;
    } catch (e) {
      debugPrint('[crash] start: $e');
    }
  }

  /// The meeting this phone is in ('' when none), attached to any crash.
  static void inMeeting(String slug) {
    if (!_on) return;
    unawaited(FirebaseCrashlytics.instance.setCustomKey('meeting', slug).catchError((_) {}));
  }
}

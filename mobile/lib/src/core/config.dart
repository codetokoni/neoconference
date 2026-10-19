import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Where the app points, and the handful of constants that follow from it.
///
/// The mobile app has no backend of its own. It signs in against the same
/// Clerk instance as the website and then calls the very same API routes, so
/// every rule about who may join a room, who may record and who may mute
/// whom stays in one place on the server.
///
/// NeoConference became NeoLinguaMeet at neolinguameet.com (2026-10-19). The
/// website moves by a switch on the server, and Clerk's sign-in address
/// moves with it — so the app does not build either address in. It asks the
/// server (GET /api/app/latest: `site`, `clerkFrontendApi`), keeps the
/// answer, and starts from it next time. The old domain keeps answering
/// /api, so the question can always be asked there.
class Config {
  const Config._();

  /// Before the server has ever answered: where 1.2.5 and earlier pointed.
  static const defaultSite = 'https://www.neoconference.app';
  static const defaultClerkFrontendApi = 'https://clerk.neoconference.app';

  /// A build pointed elsewhere, which the server's answer never overrides:
  ///   flutter run --dart-define=NEO_SITE=https://neoconference-xyz.vercel.app
  static const _siteDefine = String.fromEnvironment('NEO_SITE');
  static const _clerkDefine = String.fromEnvironment('NEO_CLERK_FAPI');

  /// The only addresses the app accepts from the server. The session token
  /// goes to [site] and the sign-in to [clerkFrontendApi], so an answer
  /// naming anything else is ignored rather than followed.
  static const allowedSites = {
    'https://www.neoconference.app',
    'https://neoconference.app',
    'https://neolinguameet.com',
    'https://www.neolinguameet.com',
  };
  static const allowedClerkFrontendApis = {
    'https://clerk.neoconference.app',
    'https://clerk.neolinguameet.com',
  };

  static String _site = _siteDefine.isNotEmpty ? _siteDefine : defaultSite;
  static String _clerk = _clerkDefine.isNotEmpty ? _clerkDefine : defaultClerkFrontendApi;

  /// The website and its API.
  static String get site => _site;

  /// Clerk's Frontend API for this instance (what the website's publishable
  /// key names).
  static String get clerkFrontendApi => _clerk;

  /// Where the sign-in browser hands control back.
  ///
  /// An Android App Link, not a custom scheme: Android gives this URL to the
  /// app only after checking assetlinks.json on the domain and confirming
  /// this app is signed by the certificate named there. Any app can register
  /// a custom scheme, and the thing being handed back is a Clerk sign-in
  /// ticket, so a hijack would be an account takeover.
  ///
  /// Deliberately the old host, not [site]: Android verified it for every
  /// install, the server keeps serving it, and a new domain's link only
  /// verifies once that domain is live.
  static const deepLinkCallback = 'https://www.neoconference.app/app/auth';

  static const _siteKey = 'neo.config.site';
  static const _clerkKey = 'neo.config.clerk';
  static bool get _pinned => _siteDefine.isNotEmpty || _clerkDefine.isNotEmpty;

  /// The addresses the server gave last time. Called before the first
  /// screen, and by anything running in its own isolate (call pushes).
  static Future<void> load() async {
    if (_pinned) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      _apply(prefs.getString(_siteKey), prefs.getString(_clerkKey));
    } catch (_) {
      // Storage that will not answer: the defaults, which the old domain serves.
    }
  }

  /// Takes the addresses from a GET /api/app/latest answer, when they are
  /// ours, and keeps them. True when either changed.
  static Future<bool> adopt(Object? body) async {
    if (_pinned || body is! Map) return false;
    final before = '$_site $_clerk';
    _apply(body['site'] as Object?, body['clerkFrontendApi'] as Object?);
    if ('$_site $_clerk' == before) return false;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_siteKey, _site);
      await prefs.setString(_clerkKey, _clerk);
    } catch (_) {
      // Used for this run even if the phone will not keep it.
    }
    return true;
  }

  /// Asks the server where things are now. Never throws, never blocks long.
  static Future<bool> refresh({http.Client? client}) async {
    if (_pinned) return false;
    final c = client ?? http.Client();
    try {
      final res = await c
          .get(Uri.parse('$_site/api/app/latest'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return false;
      return await adopt(jsonDecode(res.body));
    } catch (_) {
      return false;
    } finally {
      if (client == null) c.close();
    }
  }

  static void _apply(Object? site, Object? clerk) {
    if (site is String && allowedSites.contains(site)) _site = site;
    if (clerk is String && allowedClerkFrontendApis.contains(clerk)) _clerk = clerk;
  }

  /// Back to the built-in addresses; for tests.
  static void resetForTest() {
    _site = _siteDefine.isNotEmpty ? _siteDefine : defaultSite;
    _clerk = _clerkDefine.isNotEmpty ? _clerkDefine : defaultClerkFrontendApi;
  }
}

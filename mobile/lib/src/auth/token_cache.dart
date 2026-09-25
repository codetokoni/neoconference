import 'dart:convert';

/// Reuses a Clerk session token for as long as it is good.
///
/// Every API call used to fetch a fresh one first. Measured on an
/// emulator, opening the app made three separate token requests to Clerk
/// — the session check, then two home-screen requests at the same moment
/// — taking 1.5 s, 0.6 s and 2.2 s, for a token that lives a minute. And
/// Clerk is the server that timed out from the phone's Wi-Fi while
/// neoconference.app answered in under a second: every extra trip to it is
/// another chance for a join or a list to fail.
///
/// A token is kept until [margin] before its own `exp`, and only for the
/// session it was issued to. Callers that ask while a fetch is under way
/// share that fetch rather than starting their own.
///
/// Inside [refreshAhead] of expiry a token is still handed out, and a new
/// one is fetched behind it. Without that, anything polling at roughly the
/// token's lifetime always found it just expired: in a meeting on the
/// phone, the chat's check every ~48 s waited 0.7–2 s for Clerk on every
/// single check.
class TokenCache {
  TokenCache({
    required this.fetch,
    this.margin = const Duration(seconds: 8),
    this.refreshAhead = const Duration(seconds: 30),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// Gets a fresh token for a session from Clerk.
  final Future<String?> Function(String sessionId) fetch;

  /// How long before expiry a token stops being handed out. Long enough to
  /// cover a slow request reaching the server after the token left here —
  /// the slowest measured on the phone took 4.7 s.
  final Duration margin;

  /// How long before expiry a new token starts being fetched in the
  /// background, while the current one is still handed out.
  final Duration refreshAhead;

  final DateTime Function() _now;

  String? _session;
  String? _jwt;
  DateTime? _expires;
  String? _inFlightSession;
  Future<String?>? _inFlight;
  int _generation = 0;

  Future<String?> get(String sessionId) {
    final jwt = _jwt;
    final expires = _expires;
    if (jwt != null &&
        expires != null &&
        _session == sessionId &&
        _now().isBefore(expires.subtract(margin))) {
      if (!_now().isBefore(expires.subtract(refreshAhead)) &&
          _inFlight == null) {
        // Still good, but not for long: get the next one behind it. A
        // failure here is not this caller's problem — the next call past
        // the margin fetches again and reports it.
        _start(sessionId).catchError((Object _) => null);
      }
      return Future.value(jwt);
    }
    if (_inFlight != null && _inFlightSession == sessionId) return _inFlight!;
    return _start(sessionId);
  }

  Future<String?> _start(String sessionId) {
    _inFlightSession = sessionId;
    return _inFlight = _fetch(sessionId, _generation);
  }

  Future<String?> _fetch(String sessionId, int generation) async {
    try {
      final jwt = await fetch(sessionId);
      // Signed out (or into another account) while this was in flight: the
      // answer belongs to nobody now.
      if (generation == _generation) remember(sessionId, jwt);
      return jwt;
    } finally {
      if (generation == _generation && _inFlightSession == sessionId) {
        _inFlight = null;
        _inFlightSession = null;
      }
    }
  }

  /// Keep a token fetched elsewhere, such as the check at startup.
  void remember(String sessionId, String? jwt) {
    final expires = jwt == null ? null : jwtExpiry(jwt);
    if (jwt == null || expires == null) {
      // Without a readable expiry there is no safe time to keep it until.
      clear();
      return;
    }
    _session = sessionId;
    _jwt = jwt;
    _expires = expires;
  }

  /// Forget everything, including a fetch still on its way.
  void clear() {
    _generation++;
    _session = null;
    _jwt = null;
    _expires = null;
    _inFlight = null;
    _inFlightSession = null;
  }
}

/// The `exp` claim of a JWT, or null when it cannot be read.
DateTime? jwtExpiry(String jwt) {
  final parts = jwt.split('.');
  if (parts.length != 3) return null;
  try {
    final payload = jsonDecode(
      utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
    );
    final exp = payload is Map ? payload['exp'] : null;
    if (exp is! num) return null;
    return DateTime.fromMillisecondsSinceEpoch(exp.toInt() * 1000);
  } catch (_) {
    return null;
  }
}

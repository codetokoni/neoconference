import 'dart:convert';

import 'package:http/http.dart' as http;

import '../core/config.dart';

/// Talks to Clerk's Frontend API the way the website's JavaScript does.
///
/// There is no Clerk SDK for Flutter that covers this instance's sign-in
/// methods, so the app speaks the same HTTP API clerk-js speaks. Two things
/// make that practical:
///
///   * A Clerk client is identified by a device token, not a cookie, so a
///     phone can hold one in ordinary storage.
///   * Sign-in "tickets" are a first-class strategy. KingsChat and NeoEmail
///     already end by minting one (see /api/auth/kingschat/callback), so the
///     app can reuse those flows untouched instead of reimplementing OAuth
///     against two providers.
///
/// The session token this returns is a short-lived JWT. Clerk's backend
/// accepts it as `Authorization: Bearer <jwt>`, which is how every call to
/// neoconference.app authenticates.
class ClerkClient {
  ClerkClient({http.Client? http_}) : _http = http_ ?? http.Client();

  final http.Client _http;

  /// Identifies this installation to Clerk.
  ///
  /// A production Clerk instance tracks the client with a `__client` cookie —
  /// the `__clerk_db_jwt` query parameter is a development-instance
  /// mechanism and is ignored here. A browser would keep this cookie on its
  /// own; a phone has to carry it deliberately, which is what this is.
  /// Losing it means signing in again, nothing worse.
  String? clientCookie;

  Uri _uri(String path) =>
      Uri.parse('${Config.clerkFrontendApi}$path').replace(queryParameters: {
        // Pinning the API version keeps a Clerk rollout from changing the
        // response shape under an already-released app.
        '__clerk_api_version': '2025-04-10',
        '_clerk_js_version': '5.0.0',
      });

  Map<String, String> _headers({bool form = true}) => {
        if (form) 'content-type': 'application/x-www-form-urlencoded',
        // Clerk keys its CORS rules to the instance's own origin.
        'origin': Config.site,
        if (clientCookie != null) 'cookie': '__client=$clientCookie',
      };

  /// Picks `__client` out of the response's Set-Cookie headers.
  ///
  /// Matched by name rather than by splitting on commas: cookie expiry dates
  /// contain commas, so naive splitting mangles them. Only this one cookie
  /// matters — the rest are for the website's own domain.
  void _rememberClientCookie(http.Response res) {
    final raw = res.headers['set-cookie'];
    if (raw == null) return;
    final match = RegExp(r'__client=([^;,\s]+)').firstMatch(raw);
    final value = match?.group(1);
    if (value != null && value.isNotEmpty) clientCookie = value;
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, String> form) async {
    final res = await _http.post(_uri(path), headers: _headers(), body: form);
    _rememberClientCookie(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      throw ClerkException.fromBody(res.statusCode, body);
    }
    return body;
  }

  /// Signs in with an email address and password.
  Future<String> signInWithPassword({
    required String email,
    required String password,
  }) async {
    final body = await _post('/v1/client/sign_ins', {
      'strategy': 'password',
      'identifier': email.trim(),
      'password': password,
    });
    return _sessionFrom(body);
  }

  /// Completes a sign-in that KingsChat or NeoEmail started.
  ///
  /// Their callbacks end by minting a Clerk sign-in token and redirecting
  /// with it as `__clerk_ticket`. Handing that ticket back here is exactly
  /// what the website's JavaScript does with the same parameter.
  Future<String> signInWithTicket(String ticket) async {
    final body = await _post('/v1/client/sign_ins', {
      'strategy': 'ticket',
      'ticket': ticket,
    });
    return _sessionFrom(body);
  }

  String _sessionFrom(Map<String, dynamic> body) {
    final response = body['response'] as Map<String, dynamic>?;
    final status = response?['status'];
    if (status != 'complete') {
      // Second factors and email codes are not enabled on this instance, so
      // anything other than "complete" is a state this app cannot finish.
      throw ClerkException(
        code: 'incomplete',
        message: 'This account needs another step to sign in. '
            'Please finish signing in on neoconference.app.',
      );
    }
    final sessionId = response?['created_session_id'] as String?;
    if (sessionId == null) {
      throw const ClerkException(
        code: 'no_session',
        message: 'Signed in, but no session came back. Please try again.',
      );
    }
    return sessionId;
  }

  /// A fresh session JWT for the Authorization header.
  ///
  /// These expire after about a minute by design, so this is called before
  /// requests rather than cached for the life of the app.
  Future<String?> sessionToken(String sessionId) async {
    try {
      final body = await _post('/v1/client/sessions/$sessionId/tokens', {});
      final jwt = body['jwt'];
      return jwt is String && jwt.isNotEmpty ? jwt : null;
    } on ClerkException {
      return null;
    }
  }

  /// The signed-in user, or null when the stored session is no longer valid.
  Future<Map<String, dynamic>?> me() async {
    final res = await _http.get(_uri('/v1/me'), headers: _headers(form: false));
    _rememberClientCookie(res);
    if (res.statusCode >= 400) return null;
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return body['response'] as Map<String, dynamic>?;
  }

  Future<void> signOut(String sessionId) async {
    try {
      await _post('/v1/client/sessions/$sessionId/remove', {});
    } on ClerkException {
      // Already gone on Clerk's side; the app clears its own copy regardless.
    }
  }

  void close() => _http.close();
}

class ClerkException implements Exception {
  const ClerkException({required this.code, required this.message});

  final String code;
  final String message;

  /// Clerk answers with `{ errors: [{ code, message, long_message }] }`.
  /// long_message is the one written for a person to read.
  factory ClerkException.fromBody(int status, Map<String, dynamic> body) {
    final errors = body['errors'];
    if (errors is List && errors.isNotEmpty) {
      final first = errors.first as Map<String, dynamic>;
      return ClerkException(
        code: (first['code'] as String?) ?? 'clerk_error',
        message: (first['long_message'] as String?) ??
            (first['message'] as String?) ??
            'Sign-in failed.',
      );
    }
    return ClerkException(code: 'http_$status', message: 'Sign-in failed.');
  }

  @override
  String toString() => '$code: $message';
}

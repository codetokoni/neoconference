import 'dart:convert';

import 'package:http/http.dart' as http;

import 'config.dart';

/// Calls neoconference.app's own API routes.
///
/// Nothing here is a mobile-only endpoint: the app uses the same routes the
/// website uses, so the rules about who may join a room, who may record and
/// who may mute whom live in exactly one place. The only difference is how
/// the request proves who is asking — a browser sends a Clerk cookie, and
/// this sends the session JWT as `Authorization: Bearer`, which Clerk's
/// middleware accepts on equal terms.
class ApiClient {
  ApiClient({required this.token, http.Client? http_})
      : _http = http_ ?? http.Client();

  /// Returns a fresh session JWT, or null when signed out. Called per
  /// request because Clerk's session tokens live about a minute.
  final Future<String?> Function() token;

  final http.Client _http;

  Future<Map<String, String>> _headers() async {
    final jwt = await token();
    return {
      'accept': 'application/json',
      if (jwt != null) 'authorization': 'Bearer $jwt',
    };
  }

  Future<dynamic> get(String path, [Map<String, String>? query]) async {
    final uri = Uri.parse('${Config.site}$path').replace(
      queryParameters: query?.isEmpty ?? true ? null : query,
    );
    final res = await _http.get(uri, headers: await _headers());
    return _decode(res, 'GET $path');
  }

  Future<dynamic> post(String path, [Object? body]) async {
    final res = await _http.post(
      Uri.parse('${Config.site}$path'),
      headers: {
        ...await _headers(),
        if (body != null) 'content-type': 'application/json',
      },
      body: body == null ? null : jsonEncode(body),
    );
    return _decode(res, 'POST $path');
  }

  dynamic _decode(http.Response res, String what) {
    dynamic body;
    try {
      body = res.body.isEmpty ? null : jsonDecode(res.body);
    } catch (_) {
      // An HTML error page, usually. Its body is no use to anyone.
      body = null;
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        status: res.statusCode,
        // The server's own words where it gave any, so a failure on a phone
        // says the same thing it would say in a browser.
        message: body is Map && body['message'] is String
            ? body['message'] as String
            : body is Map && body['error'] is String
                ? body['error'] as String
                : 'Request failed ($what, HTTP ${res.statusCode}).',
        body: body is Map<String, dynamic> ? body : const {},
      );
    }
    return body;
  }

  void close() => _http.close();
}

class ApiException implements Exception {
  const ApiException({
    required this.status,
    required this.message,
    this.body = const {},
  });

  final int status;
  final String message;

  /// The whole decoded error body.
  ///
  /// Several routes answer a refusal with more than a sentence — the token
  /// route says `{ error: 'waiting_room', status: 'pending' }`, or
  /// `{ error: 'room_full', limit, occupancy }`. Those extra fields decide
  /// what the app shows next, so they must survive the throw.
  final Map<String, dynamic> body;

  /// The machine-readable reason, e.g. 'waiting_room' or 'wait_for_host'.
  String get code => body['error'] is String ? body['error'] as String : '';

  /// True when the session itself is no good. A 403 is deliberately not
  /// counted: the join route returns 403 for a locked or full room, and
  /// signing the person out for that would be wrong.
  bool get isUnauthenticated => status == 401;

  @override
  String toString() => message;
}

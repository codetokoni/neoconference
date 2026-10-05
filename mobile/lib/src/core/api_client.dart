import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;

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
  ApiClient({required this.token, this.freshToken, http.Client? http_})
      : _http = http_ ?? http.Client();

  /// Returns a fresh session JWT, or null when signed out. Called per
  /// request because Clerk's session tokens live about a minute.
  final Future<String?> Function() token;

  /// A token fetched now rather than cached, for one retry when the server
  /// answers 401 to a request that carried a token. Reported from a phone
  /// that changed networks mid-meeting: rejoining said "Could not join:
  /// Unauthorized" while the person was signed in all along.
  final Future<String?> Function()? freshToken;

  final http.Client _http;

  Map<String, String> _headersWith(String? jwt) => {
        'accept': 'application/json',
        if (jwt != null) 'authorization': 'Bearer $jwt',
      };

  /// Sends a request built for a token; on a 401 to a request that carried
  /// one, sends it once more with a token fetched now.
  Future<dynamic> _send(String what, Future<http.Response> Function(Map<String, String> headers) send) async {
    final clock = Stopwatch()..start();
    var jwt = await token();
    final tokenMs = clock.elapsedMilliseconds;
    var res = await send(_headersWith(jwt));
    _time(what, tokenMs, clock.elapsedMilliseconds, res.statusCode);
    final renew = freshToken;
    if (refusedSignIn(res) && jwt != null && renew != null) {
      final again = await renew();
      if (again != null && again != jwt) {
        debugPrint('[api] $what: 401 with a cached token; retrying with a fresh one');
        jwt = again;
        res = await send(_headersWith(jwt));
      }
    }
    return _decode(res, what);
  }

  Future<dynamic> get(String path, [Map<String, String>? query]) {
    final uri = Uri.parse('${Config.site}$path').replace(
      queryParameters: query?.isEmpty ?? true ? null : query,
    );
    return _send('GET $path', (headers) => _http.get(uri, headers: headers));
  }

  Future<dynamic> post(String path, [Object? body]) {
    return _send(
      'POST $path',
      (headers) => _http.post(
        Uri.parse('${Config.site}$path'),
        headers: {
          ...headers,
          if (body != null) 'content-type': 'application/json',
        },
        body: body == null ? null : jsonEncode(body),
      ),
    );
  }

  /// Uploads one file as multipart form data, in a field named [field].
  Future<dynamic> postFile(
    String path, {
    required List<int> bytes,
    required String filename,
    required String mimeType,
    String field = 'file',
  }) {
    return _send('POST $path', (headers) async {
      final request = http.MultipartRequest('POST', Uri.parse('${Config.site}$path'))
        ..headers.addAll(headers)
        ..files.add(http.MultipartFile.fromBytes(
          field,
          bytes,
          filename: filename,
          contentType: MediaType.parse(mimeType),
        ));
      return http.Response.fromStream(await _http.send(request));
    });
  }

  Future<dynamic> patch(String path, [Object? body]) => _withBody('PATCH', path, body);

  Future<dynamic> delete(String path, [Object? body]) => _withBody('DELETE', path, body);

  Future<dynamic> _withBody(String method, String path, Object? body) {
    return _send('$method $path', (headers) async {
      final request = http.Request(method, Uri.parse('${Config.site}$path'))
        ..headers.addAll({
          ...headers,
          if (body != null) 'content-type': 'application/json',
        });
      if (body != null) request.body = jsonEncode(body);
      return http.Response.fromStream(await _http.send(request));
    });
  }

  /// Logs a slow request, split into getting the session token and the
  /// request itself — they fail for different reasons and live on
  /// different servers (Clerk and neoconference.app).
  void _time(String what, int tokenMs, int totalMs, int status) {
    if (totalMs < slowMs) return;
    debugPrint('[api] $what: ${totalMs}ms '
        '(token ${tokenMs}ms, request ${totalMs - tokenMs}ms) -> $status');
  }

  /// Requests faster than this are not logged. A build made with
  /// --dart-define=NEO_LOG_ALL_REQUESTS=true logs every one, for measuring.
  static int slowMs =
      const bool.fromEnvironment('NEO_LOG_ALL_REQUESTS') ? 0 : 1000;

  /// The site's sign-in check refused the request. A route that answers
  /// for itself says 401; the sign-in check in front of the other routes
  /// answers **404** with `x-clerk-auth-status: signed-out` instead. In
  /// neodevteam the chat said "Could not load earlier messages (HTTP 404)"
  /// to someone signed in all along — the same stale token as the
  /// "Unauthorized" on joining, which this 404 was never retried for.
  static bool refusedSignIn(http.Response res) =>
      res.statusCode == 401 ||
      (res.statusCode == 404 && res.headers['x-clerk-auth-status'] == 'signed-out');

  dynamic _decode(http.Response res, String what) {
    if (refusedSignIn(res) && res.statusCode == 404) {
      // Said as what it is, so callers treat it as a sign-in problem.
      throw const ApiException(status: 401, message: 'Your sign-in needs refreshing.');
    }
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

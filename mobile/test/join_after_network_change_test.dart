import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/auth/clerk_client.dart';
import 'package:neoconference/src/auth/token_cache.dart';
import 'package:neoconference/src/core/api_client.dart';

/// Reported from a phone that changed networks during a meeting: rejoining
/// said "Could not join: Unauthorized" to someone signed in all along.
void main() {
  signedOut404Tests();

  group('the API client', () {
    test('retries a 401 once with a token fetched now', () async {
      final seen = <String?>[];
      final api = ApiClient(
        token: () async => 'stale',
        freshToken: () async => 'fresh',
        http_: MockClient((req) async {
          final auth = req.headers['authorization'];
          seen.add(auth);
          return auth == 'Bearer fresh'
              ? http.Response('{"token":"lk","wsUrl":"wss://x"}', 200)
              : http.Response('{"error":"Unauthorized"}', 401);
        }),
      );

      final body = await api.get('/api/livekit/token', {'room': 'neodevteam'});

      expect(body['token'], 'lk');
      expect(seen, ['Bearer stale', 'Bearer fresh']);
    });

    test('does not retry for someone signed out', () async {
      var calls = 0;
      final api = ApiClient(
        token: () async => null,
        freshToken: () async => 'fresh',
        http_: MockClient((req) async {
          calls++;
          return http.Response('{"error":"Unauthorized"}', 401);
        }),
      );
      await expectLater(api.get('/api/x'), throwsA(isA<ApiException>()));
      expect(calls, 1);
    });

    test('a refusal that stands is still reported', () async {
      final api = ApiClient(
        token: () async => 'stale',
        freshToken: () async => 'fresh',
        http_: MockClient((req) async => http.Response('{"error":"Unauthorized"}', 401)),
      );
      await expectLater(
        api.post('/api/x', {'a': 1}),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)),
      );
    });
  });

  group('Clerk', () {
    ClerkClient clerk(int status, Map<String, dynamic> body) => ClerkClient(
          http_: MockClient((req) async => http.Response(jsonEncode(body), status)),
        );

    test('a session that is gone means signed out', () async {
      final c = clerk(404, {
        'errors': [
          {'code': 'resource_not_found', 'message': 'not found'},
        ],
      });
      expect(await c.sessionToken('sess_1'), isNull);
    });

    test('Clerk busy or down is a failure, not "signed out"', () async {
      for (final status in [429, 500, 502, 503]) {
        final c = clerk(status, {
          'errors': [
            {'code': 'oops', 'message': 'try later'},
          ],
        });
        await expectLater(c.sessionToken('sess_1'), throwsA(isA<ClerkException>()), reason: '$status');
      }
    });
  });

  test('renew drops the cached token and fetches one', () async {
    var n = 0;
    String jwt(int i) {
      final exp = DateTime.now().add(const Duration(minutes: 1)).millisecondsSinceEpoch ~/ 1000;
      final payload = base64Url.encode(utf8.encode(jsonEncode({'exp': exp, 'i': i}))).replaceAll('=', '');
      return 'h.$payload.s';
    }

    final cache = TokenCache(fetch: (_) async => jwt(++n));
    final first = await cache.get('sess_1');
    expect(await cache.get('sess_1'), first, reason: 'cached');
    final renewed = await cache.renew('sess_1');
    expect(renewed, isNot(first));
    expect(await cache.get('sess_1'), renewed);
  });
}

/// The sign-in check in front of most routes refuses with 404 and
/// x-clerk-auth-status: signed-out, not 401. Seen in neodevteam's chat:
/// "Could not load earlier messages (HTTP 404)".
void signedOut404Tests() {
  test('a signed-out 404 is retried with a fresh token', () async {
    final seen = <String?>[];
    final api = ApiClient(
      token: () async => 'stale',
      freshToken: () async => 'fresh',
      http_: MockClient((req) async {
        final auth = req.headers['authorization'];
        seen.add(auth);
        return auth == 'Bearer fresh'
            ? http.Response('{"messages":[]}', 200)
            : http.Response('<html>404</html>', 404, headers: {'x-clerk-auth-status': 'signed-out'});
      }),
    );
    final body = await api.get('/api/events/neodevteam/chat');
    expect(body['messages'], isEmpty);
    expect(seen, ['Bearer stale', 'Bearer fresh']);
  });

  test('a signed-out 404 that stands reads as a sign-in problem', () async {
    final api = ApiClient(
      token: () async => 'stale',
      freshToken: () async => 'fresh',
      http_: MockClient((req) async =>
          http.Response('<html>404</html>', 404, headers: {'x-clerk-auth-status': 'signed-out'})),
    );
    await expectLater(
      api.get('/api/events/neodevteam/chat'),
      throwsA(isA<ApiException>().having((e) => e.isUnauthenticated, 'isUnauthenticated', isTrue)),
    );
  });

  test('a real not-found is not retried', () async {
    var calls = 0;
    final api = ApiClient(
      token: () async => 'stale',
      freshToken: () async => 'fresh',
      http_: MockClient((req) async {
        calls++;
        return http.Response('{"error":"not_found"}', 404);
      }),
    );
    await expectLater(api.get('/api/events/gone/chat'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
    expect(calls, 1);
  });
}

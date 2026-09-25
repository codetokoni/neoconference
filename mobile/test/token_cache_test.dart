import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/auth/token_cache.dart';

/// A JWT whose only meaningful claim is `exp`. The signature is never
/// checked here — the server does that.
String jwt(DateTime expires, {String sub = 'user'}) {
  String part(Map<String, Object> m) =>
      base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '');
  return '${part({'alg': 'RS256'})}.'
      '${part({'sub': sub, 'exp': expires.millisecondsSinceEpoch ~/ 1000})}.sig';
}

void main() {
  late DateTime now;
  late List<String> fetched;
  late List<Completer<String?>> pending;
  late TokenCache cache;

  setUp(() {
    now = DateTime(2026, 9, 25, 16);
    fetched = [];
    pending = [];
    cache = TokenCache(
      now: () => now,
      fetch: (session) {
        fetched.add(session);
        final c = Completer<String?>();
        pending.add(c);
        return c.future;
      },
    );
  });

  test('reads exp from a JWT', () {
    final exp = DateTime(2026, 9, 25, 16, 1);
    expect(jwtExpiry(jwt(exp)), exp);
    expect(jwtExpiry('not-a-jwt'), isNull);
    expect(jwtExpiry('a.b.c'), isNull);
  });

  test('a good token is reused, not fetched again', () async {
    final t = jwt(now.add(const Duration(seconds: 60)));
    final first = cache.get('sess_1');
    pending.single.complete(t);
    expect(await first, t);

    now = now.add(const Duration(seconds: 20)); // well before any refresh
    expect(await cache.get('sess_1'), t);
    expect(fetched, ['sess_1'], reason: 'one trip to Clerk, not two');
  });

  test('a token near expiry is still used, and the next one fetched behind it',
      () async {
    // The meeting chat polls every ~48 s. On the phone each poll found the
    // token just expired and waited 0.7–2 s for Clerk.
    final t = jwt(now.add(const Duration(seconds: 60)));
    final first = cache.get('sess_1');
    pending.single.complete(t);
    await first;

    now = now.add(const Duration(seconds: 48)); // 12 s left
    expect(await cache.get('sess_1'), t, reason: 'no wait for this caller');
    expect(fetched, ['sess_1', 'sess_1'], reason: 'the next one is on its way');

    cache.get('sess_1');
    expect(fetched, hasLength(2), reason: 'one background fetch, not one each');

    final next = jwt(now.add(const Duration(seconds: 60)));
    pending.last.complete(next);
    await pumpEventQueue();
    expect(await cache.get('sess_1'), next);
  });

  test('a token about to expire is not handed out', () async {
    final t = jwt(now.add(const Duration(seconds: 60)));
    final first = cache.get('sess_1');
    pending.single.complete(t);
    await first;

    now = now.add(const Duration(seconds: 55)); // 5 s left, inside margin
    final waiting = cache.get('sess_1');
    final next = jwt(now.add(const Duration(seconds: 60)));
    pending.last.complete(next);
    expect(await waiting, next);
  });

  test('a background refresh that fails costs the caller nothing', () async {
    final t = jwt(now.add(const Duration(seconds: 60)));
    final first = cache.get('sess_1');
    pending.single.complete(t);
    await first;

    now = now.add(const Duration(seconds: 40)); // 20 s left
    expect(await cache.get('sess_1'), t);
    pending.last.completeError(Exception('Connection reset by peer'));
    await pumpEventQueue(); // an unhandled error here would fail the test

    expect(await cache.get('sess_1'), t, reason: 'still good, still used');
  });

  test('a fresh token is not refreshed early', () async {
    final t = jwt(now.add(const Duration(seconds: 60)));
    final first = cache.get('sess_1');
    pending.single.complete(t);
    await first;

    now = now.add(const Duration(seconds: 20)); // 40 s left
    await cache.get('sess_1');
    expect(fetched, ['sess_1'], reason: 'no trip to Clerk while there is time');
  });

  test('callers asking at the same moment share one fetch', () async {
    // The home screen's two requests at startup made two trips to Clerk.
    final a = cache.get('sess_1');
    final b = cache.get('sess_1');
    expect(fetched, ['sess_1']);
    final t = jwt(now.add(const Duration(seconds: 60)));
    pending.single.complete(t);
    expect(await a, t);
    expect(await b, t);
  });

  test('never hands one session the token of another', () async {
    final first = cache.get('sess_1');
    pending.single.complete(jwt(now.add(const Duration(seconds: 60))));
    await first;

    cache.get('sess_2');
    expect(fetched, ['sess_1', 'sess_2']);
  });

  test('a fetch that lands after sign-out is not kept', () async {
    final inFlight = cache.get('sess_1');
    cache.clear();
    pending.single.complete(jwt(now.add(const Duration(seconds: 60))));
    await inFlight;

    cache.get('sess_1');
    expect(fetched, ['sess_1', 'sess_1'], reason: 'the stale answer was dropped');
  });

  test('a failed fetch is not cached, and the next call tries again',
      () async {
    final first = cache.get('sess_1');
    pending.single.completeError(Exception('Connection reset by peer'));
    await expectLater(first, throwsException);

    cache.get('sess_1');
    expect(fetched, ['sess_1', 'sess_1']);
  });

  test('a token without a readable expiry is not kept', () async {
    final first = cache.get('sess_1');
    pending.single.complete('opaque-token');
    expect(await first, 'opaque-token');

    cache.get('sess_1');
    expect(fetched, ['sess_1', 'sess_1']);
  });

  test('a token remembered from elsewhere is used', () async {
    final t = jwt(now.add(const Duration(seconds: 60)));
    cache.remember('sess_1', t);
    expect(await cache.get('sess_1'), t);
    expect(fetched, isEmpty);
  });
}

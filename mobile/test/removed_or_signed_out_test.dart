import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_riverpod/flutter_riverpod.dart' show StateNotifier;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:neoconference/src/auth/auth_controller.dart';
import 'package:neoconference/src/auth/clerk_client.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A notifier's current state, as a listener sees it.
T now<T>(StateNotifier<T> n) {
  late T value;
  n.addListener((s) => value = s)();
  return value;
}

/// Taken out of a meeting: by a host, or because this phone was signed out.
///
/// The server takes a signed-out device out of its meetings (#624), and
/// LiveKit reports that as "participant removed", the same as a host doing
/// it. 1.2.9 said "A host took you out of this meeting." to someone whose
/// account had just signed in on another phone.
void main() {
  const otherDevice = 'You have been signed out because your account was signed in on another device.';

  setUpAll(() {
    // WebRTC's native plugin does not exist in tests, and the LiveKit Room
    // the controller makes lists devices through it.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('FlutterWebRTC.Method'),
      (call) async => call.method == 'getSources' ? {'sources': <Object>[]} : null,
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('com.llfbandit.app_links/messages'), (_) async => null);
  });

  group('the meeting', () {
    /// A controller whose sign-out lookup answers [answer]; built on the
    /// real clock (the LiveKit Room's cleanup timer is never cancelled).
    Future<RoomController> room(WidgetTester tester, Future<String?> Function()? answer) async {
      late RoomController c;
      await tester.runAsync(() async {
        c = RoomController(api: ApiClient(token: () async => null), slug: 't', signedOutReason: answer);
      });
      return c;
    }

    testWidgets('removed because this phone was signed out: says so, in the site\'s words', (tester) async {
      final c = await room(tester, () async => otherDevice);
      c.receiveDisconnect(RoomDisconnectedEvent(reason: DisconnectReason.participantRemoved));
      await tester.pump();
      expect(now(c).drop?.headline, 'You were signed out');
      expect(now(c).drop?.message, otherDevice);
      expect(now(c).drop?.canRejoin, isFalse);
    });

    testWidgets('removed by a host: still says a host did it', (tester) async {
      final c = await room(tester, () async => null);
      c.receiveDisconnect(RoomDisconnectedEvent(reason: DisconnectReason.participantRemoved));
      await tester.pump();
      expect(now(c).drop?.headline, 'You were removed from the meeting');
      expect(now(c).drop?.message, 'A host took you out of this meeting.');
    });

    testWidgets('no answer about the sign-out: a host did it', (tester) async {
      final c = await room(tester, () async => throw Exception('offline'));
      c.receiveDisconnect(RoomDisconnectedEvent(reason: DisconnectReason.participantRemoved));
      await tester.pump();
      expect(now(c).drop?.headline, 'You were removed from the meeting');
    });

    testWidgets('only a removal asks: a lost network drops at once', (tester) async {
      var asked = 0;
      final c = await room(tester, () async {
        asked++;
        return otherDevice;
      });
      c.receiveDisconnect(RoomDisconnectedEvent(reason: DisconnectReason.roomDeleted));
      await tester.pump();
      expect(now(c).drop?.headline, 'The meeting has ended');
      expect(asked, 0);
    });

    testWidgets('until the answer, nothing is said yet', (tester) async {
      final answer = Completer<String?>();
      final c = await room(tester, () => answer.future);
      c.receiveDisconnect(RoomDisconnectedEvent(reason: DisconnectReason.participantRemoved));
      await tester.pump();
      expect(now(c).drop, isNull);
      answer.complete(otherDevice);
      await tester.pump();
      expect(now(c).drop?.headline, 'You were signed out');
    });
  });

  group('AuthController.signedOutReason', () {
    late bool live;
    final asked = <String>[];
    final site = MockClient((req) async {
      asked.add(req.url.toString());
      final revoked = !live && req.url.queryParameters['session'] == 'sess_phone123456';
      return http.Response(
        jsonEncode({'reason': revoked ? 'other_device' : null, 'message': revoked ? otherDevice : null}),
        200,
      );
    });
    ClerkClient clerk() => ClerkClient(
          http_: MockClient((req) async {
            if (!req.url.path.endsWith('/tokens')) return http.Response('{}', 200);
            final payload = base64Url.encode(utf8.encode('{"exp":0}')).replaceAll('=', '');
            return live
                ? http.Response('{"jwt":"h.$payload.s"}', 200)
                : http.Response('{"errors":[{"code":"session_not_found","message":"gone"}]}', 404);
          }),
        );

    setUp(() {
      live = true;
      asked.clear();
      SharedPreferences.setMockInitialValues({'neo.clerk.session': 'sess_phone123456'});
    });

    Future<AuthController> signedIn(WidgetTester tester) async {
      final auth = AuthController(clerk(), site: site);
      addTearDown(auth.dispose);
      await tester.pump(const Duration(milliseconds: 100));
      expect(now(auth).signedIn, isTrue);
      return auth;
    }

    testWidgets('a live session: null', (tester) async {
      final auth = await signedIn(tester);
      expect(await auth.signedOutReason(), isNull);
      expect(asked.last, contains('/api/auth/signed-out-reason?session=sess_phone123456'));
    });

    testWidgets('signed out on the server, not noticed here yet: the site\'s words', (tester) async {
      final auth = await signedIn(tester);
      live = false;
      expect(await auth.signedOutReason(), otherDevice);
    });

    testWidgets('already noticed here (the session is gone): still the reason', (tester) async {
      final auth = await signedIn(tester);
      live = false;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump(const Duration(milliseconds: 200));
      expect(now(auth).signedIn, isFalse);
      expect(await auth.signedOutReason(), otherDevice);
    });
  });
}

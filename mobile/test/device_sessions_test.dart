import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/auth/auth_controller.dart';
import 'package:neoconference/src/auth/clerk_client.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/settings/device_sessions_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// One device at a time (2026-11-03): a phone signed out because the
/// account signed in somewhere else says so, leaving or minimising the app
/// never signs out by itself, and Settings → Security → Device sessions
/// shows and changes where the account is signed in.
void main() {
  const otherDevice = 'You have been signed out because your account was signed in on another device.';

  setUp(() {
    SharedPreferences.setMockInitialValues({'neo.clerk.session': 'sess_phone123456'});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('com.llfbandit.app_links/messages'), (_) async => null);
  });

  /// Clerk, answering token requests while [accepts] says the session lives.
  ClerkClient clerk(bool Function() accepts) => ClerkClient(
        http_: MockClient((req) async {
          if (!req.url.path.endsWith('/tokens')) return http.Response('{}', 200);
          // A token that expires at once, so every check asks Clerk again.
          final payload = base64Url.encode(utf8.encode('{"exp":0}')).replaceAll('=', '');
          return accepts()
              ? http.Response('{"jwt":"h.$payload.s"}', 200)
              : http.Response('{"errors":[{"code":"session_not_found","message":"gone"}]}', 404);
        }),
      );

  final asked = <String>[];
  final site = MockClient((req) async {
    asked.add(req.url.toString());
    final revoked = req.url.queryParameters['session'] == 'sess_phone123456';
    return http.Response(
      jsonEncode({'reason': revoked ? 'other_device' : null, 'message': revoked ? otherDevice : null}),
      200,
    );
  });

  Future<ProviderContainer> app(WidgetTester tester, ClerkClient c) async {
    final container = ProviderContainer(overrides: [
      authProvider.overrideWith((ref) => AuthController(c, site: site)),
    ]);
    addTearDown(container.dispose);
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        home: Consumer(builder: (context, ref, _) {
          final auth = ref.watch(authProvider);
          if (auth.restoring) return const Text('restoring');
          return auth.signedIn ? const Text('HOME') : Text('SIGN IN ${auth.error ?? ''}');
        }),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 100));
    return container;
  }

  testWidgets('a session ended by a sign-in elsewhere says why on the sign-in screen', (tester) async {
    asked.clear();
    await app(tester, clerk(() => false));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('SIGN IN $otherDevice'), findsOneWidget);
    expect(asked.single, contains('/api/auth/signed-out-reason?session=sess_phone123456'));
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('neo.clerk.session'), isNull);
  });

  testWidgets('leaving the app and coming back keeps you signed in', (tester) async {
    await app(tester, clerk(() => true));
    for (final s in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
      tester.binding.handleAppLifecycleStateChanged(s);
      await tester.pump(const Duration(milliseconds: 50));
    }
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('HOME'), findsOneWidget);
  });

  testWidgets('signed out elsewhere while in the background: coming back says so', (tester) async {
    var live = true;
    await app(tester, clerk(() => live));
    expect(find.text('HOME'), findsOneWidget);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    live = false;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('SIGN IN $otherDevice'), findsOneWidget);
  });

  testWidgets('Device sessions lists devices, signs one out, and switches multiple devices', (tester) async {
    final posted = <Map<String, dynamic>>[];
    var state = <String, dynamic>{
      'multiDevice': false,
      'devices': [
        {'id': 'sess_phone123456', 'label': 'NeoLinguaMeet app on Android', 'current': true, 'ip': '203.0.113.7', 'lastActiveAt': DateTime.now().millisecondsSinceEpoch},
        {'id': 'sess_laptop12345', 'label': 'Chrome on Windows', 'current': false, 'ip': null, 'lastActiveAt': DateTime.now().millisecondsSinceEpoch},
      ],
    };
    final api = ApiClient(
      token: () async => 'jwt',
      http_: MockClient((req) async {
        expect(req.url.path, '/api/auth/devices');
        if (req.method == 'POST') {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          posted.add(body);
          if (body['action'] == 'sign_out') {
            state = {...state, 'devices': [(state['devices'] as List).first]};
          } else if (body['action'] == 'multi') {
            state = {...state, 'multiDevice': body['on']};
          }
        }
        return http.Response(jsonEncode(state), 200);
      }),
    );
    await tester.pumpWidget(ProviderScope(
      overrides: [apiProvider.overrideWithValue(api)],
      child: const MaterialApp(home: DeviceSessionsScreen()),
    ));
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('NeoLinguaMeet app on Android'), findsOneWidget);
    expect(find.text('This device'), findsOneWidget);
    expect(find.text('Chrome on Windows'), findsOneWidget);
    expect(find.text('Sign out all other devices'), findsOneWidget);
    expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value, isFalse, reason: 'off by default');

    await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(posted.last, {'action': 'sign_out', 'id': 'sess_laptop12345'});
    expect(find.text('Chrome on Windows'), findsNothing);
    expect(find.text('Sign out all other devices'), findsNothing);

    await tester.tap(find.byType(SwitchListTile));
    await tester.pump(const Duration(milliseconds: 100));
    expect(posted.last, {'action': 'multi', 'on': true});
    expect(tester.widget<SwitchListTile>(find.byType(SwitchListTile)).value, isTrue);
  });
}

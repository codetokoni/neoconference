import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/auth/auth_controller.dart';
import 'package:neoconference/src/auth/clerk_client.dart';
import 'package:neoconference/src/billing/plan.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/settings/settings_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// "Could not load your plan — Couldn't reach NeoLinguaMeet. Check your
/// connection and try again." (owner's phone, 2026-10-20). The phone's
/// network had failed to look up clerk.neoconference.app for a moment;
/// requests either side of it worked. The plan was never asked for again
/// until the app restarted, and the card said "try again" with no way to.
void main() {
  final planJson = jsonEncode({
    'plan': 'pro',
    'limits': {'maxParticipants': 100, 'meetingMinutes': 300, 'translation': true},
  });
  final lookupFailed = http.ClientException(
    "SocketException: Failed host lookup: 'clerk.neoconference.app'",
    Uri.parse('https://clerk.neoconference.app/v1/client/sessions/sess_1/tokens'),
  );

  setUp(() {
    SharedPreferences.setMockInitialValues({'neo.clerk.session': 'sess_1'});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('com.llfbandit.app_links/messages'), (_) async => null);
    planRetryDelays = const [Duration(milliseconds: 5), Duration(milliseconds: 5), Duration(milliseconds: 5)];
  });

  /// An API whose first [failures] requests fail as [error] would.
  ApiClient api(List<Uri> asked, {int failures = 0, Object? error, int status = 200}) {
    var n = 0;
    return ApiClient(
      token: () async => 'jwt',
      http_: MockClient((req) async {
        asked.add(req.url);
        if (n++ < failures) throw error ?? lookupFailed;
        return http.Response(status == 200 ? planJson : '{"error":"boom"}', status);
      }),
    );
  }

  /// Clerk accepts the stored session: signing in is not what is tested.
  ClerkClient clerk() => ClerkClient(
        http_: MockClient((req) async => http.Response(req.url.path.endsWith('/tokens') ? '{"jwt":"a.b.c"}' : '{}', 200)),
      );

  ProviderContainer container(ApiClient a) {
    // No stored session: restoring one would re-read the plan part-way.
    SharedPreferences.setMockInitialValues({});
    final c = ProviderContainer(overrides: [
      apiProvider.overrideWithValue(a),
      clerkClientProvider.overrideWithValue(clerk()),
    ]);
    addTearDown(c.dispose);
    return c;
  }

  test('a moment without the network is asked again, and the plan arrives', () async {
    final asked = <Uri>[];
    final c = container(api(asked, failures: 2));
    final plan = await c.read(planProvider.future);
    expect(plan.plan, 'pro');
    expect(asked.length, 3);
  });

  test('a lookup failure on its own counts as the network, not as an answer', () async {
    final asked = <Uri>[];
    final c = container(api(asked, failures: 1, error: const SocketException('Failed host lookup')));
    expect((await c.read(planProvider.future)).plan, 'pro');
    expect(asked.length, 2);
  });

  test('it gives up after a few tries, and says the network', () async {
    final asked = <Uri>[];
    final c = container(api(asked, failures: 99));
    await expectLater(c.read(planProvider.future), throwsA(isA<http.ClientException>()));
    expect(asked.length, 4); // the first try and three more
  });

  test('a server that answers with an error is not asked again', () async {
    final asked = <Uri>[];
    final c = container(api(asked, status: 500));
    await expectLater(c.read(planProvider.future), throwsA(isA<ApiException>()));
    expect(asked.length, 1);
  });

  testWidgets('on Profile, tapping "Could not load your plan" reads it again', (tester) async {
    var reads = 0;
    await tester.pumpWidget(ProviderScope(
      overrides: [
        clerkClientProvider.overrideWithValue(clerk()),
        planProvider.overrideWith((ref) {
          reads++;
          return reads == 1
              ? Future<PlanInfo>.error(lookupFailed)
              : Future.value(PlanInfo.fromJson(jsonDecode(planJson) as Map<String, dynamic>));
        }),
      ],
      child: const MaterialApp(home: Scaffold(body: SettingsScreen())),
    ));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Could not load your plan'), findsOneWidget);
    expect(find.textContaining('Tap to try again.'), findsOneWidget);

    await tester.tap(find.text('Could not load your plan'));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(reads, 2);
    expect(find.text('Could not load your plan'), findsNothing);
    expect(find.text('Pro'), findsOneWidget);
  });
}

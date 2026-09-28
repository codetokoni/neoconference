import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/auth/auth_controller.dart';
import 'package:neoconference/src/auth/clerk_client.dart';
import 'package:neoconference/src/billing/plan.dart';
import 'package:neoconference/src/settings/settings_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Signing out from the Profile tab.
///
/// On build 3153 it left a black screen: Settings popped the route it was
/// on, which as the Profile tab is the root itself, so the navigator was
/// empty when the root switched to the sign-in screen. Built here the way
/// main.dart builds it — a root that shows the tabs when signed in and the
/// sign-in screen when not — with Settings as a tab, not a pushed page.
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({'neo.clerk.session': 'sess_1'});
    // AppLinks has no platform side in a test; nothing arrives on it.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('com.llfbandit.app_links/messages'), (_) async => null);
  });

  testWidgets('signing out from the Profile tab lands on the sign-in screen', (tester) async {
    // Clerk accepts the stored session (a token for it) and anything else.
    final clerk = ClerkClient(
      http_: MockClient((req) async => http.Response(
            req.url.path.endsWith('/tokens') ? '{"jwt":"a.b.c"}' : '{}',
            200,
          )),
    );

    await tester.pumpWidget(ProviderScope(
      overrides: [
        clerkClientProvider.overrideWithValue(clerk),
        planProvider.overrideWith((ref) => Completer<PlanInfo>().future),
      ],
      child: MaterialApp(
        home: Consumer(
          builder: (context, ref, _) {
            final auth = ref.watch(authProvider);
            if (auth.restoring) return const Text('restoring');
            return auth.signedIn
                ? const Scaffold(body: SettingsScreen())
                : const Text('SIGN IN SCREEN');
          },
        ),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(SettingsScreen), findsOneWidget);

    final signOut = find.widgetWithText(OutlinedButton, 'Sign out');
    await tester.scrollUntilVisible(signOut, 200, scrollable: find.byType(Scrollable).first);
    await tester.tap(signOut);
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.widgetWithText(FilledButton, 'Sign out'));
    await tester.pump(const Duration(milliseconds: 500));

    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('SIGN IN SCREEN'), findsOneWidget);
  });
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/billing/plan.dart';
import 'package:neoconference/src/billing/upgrade.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/home/landing_screen.dart';

/// Paying from the Plans and pricing page.
///
/// Seen on the phone: the plan cards described their plans and did nothing
/// when tapped. The only way to pay was the Upgrade button on the card
/// above, which is hidden on Enterprise and scrolled off screen by the time
/// the prices are — so "click to make payment" did nothing at all.
void main() {
  const enterprise = PlanInfo(
    plan: 'enterprise',
    maxParticipants: 0,
    meetingMinutes: 0,
    recording: true,
    breakouts: true,
    branding: true,
    livestream: true,
    translation: true,
  );

  Widget app(List<http.Request> sent, {AsyncValue<PlanInfo>? plan}) => ProviderScope(
        overrides: [
          planProvider.overrideWith((ref) => plan == null
              ? Future.value(enterprise)
              : plan.when(
                  data: (p) => Future.value(p),
                  error: (e, s) => Future<PlanInfo>.error(e, s),
                  loading: () => Completer<PlanInfo>().future,
                )),
          apiProvider.overrideWithValue(ApiClient(
            token: () async => 'jwt',
            http_: MockClient((req) async {
              sent.add(req);
              // The server returns no page: the sheet reports that, and the
              // request it made is what this test is about.
              return http.Response('{}', 200);
            }),
          )),
        ],
        child: const MaterialApp(home: LandingScreen()),
      );

  testWidgets('choosing a plan on its card starts paying for that plan', (tester) async {
    final sent = <http.Request>[];
    await tester.pumpWidget(app(sent));
    await tester.pumpAndSettle();

    // Enterprise has no Upgrade button; the cards must still sell.
    expect(find.widgetWithText(TextButton, 'Upgrade'), findsNothing);

    await tester.scrollUntilVisible(find.text('Choose Business'), 200);
    // Found is not on screen: the list builds a little past the viewport,
    // and a tap on a node below it lands on nothing.
    await tester.ensureVisible(find.text('Choose Business'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose Business'));
    await tester.pumpAndSettle();

    expect(find.byType(UpgradeSheet), findsOneWidget);
    expect(find.text('30 ESP per month'), findsOneWidget);

    await tester.tap(find.text('Continue to payment'));
    await tester.pumpAndSettle();

    final checkout = sent.where((r) => r.url.path == '/api/billing/espees/checkout').toList();
    expect(checkout, hasLength(1));
    expect(jsonDecode(checkout.single.body), containsPair('plan', 'business'));
    expect(jsonDecode(checkout.single.body), containsPair('billingCycle', 'monthly'));
    expect(find.text('The server did not return a payment page.'), findsOneWidget);
  });

  testWidgets('tapping anywhere on a card opens it on that plan', (tester) async {
    final sent = <http.Request>[];
    await tester.pumpWidget(app(sent));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('· 100 participants'), 200);
    await tester.ensureVisible(find.text('· 100 participants'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('· 100 participants'));
    await tester.pumpAndSettle();

    expect(find.byType(UpgradeSheet), findsOneWidget);
    expect(find.text('10 ESP per month'), findsOneWidget);
    expect(find.text('Starter does not include live translation.'), findsOneWidget);
  });

  testWidgets('a plan that failed to load does not stop the person paying', (tester) async {
    final sent = <http.Request>[];
    await tester.pumpWidget(app(sent, plan: AsyncValue.error(Exception('offline'), StackTrace.empty)));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Choose Pro'), 200);
    await tester.ensureVisible(find.text('Choose Pro'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Choose Pro'));
    await tester.pumpAndSettle();

    expect(find.byType(UpgradeSheet), findsOneWidget);
    expect(find.text('Choose a plan.'), findsOneWidget);
    expect(find.text('20 ESP per month'), findsOneWidget);
  });
}

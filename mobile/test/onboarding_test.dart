import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/onboarding/onboarding.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Asked for: the first time the app opens, pages about what it is — live
/// translation and the rest — before the sign-in page. Once.
void main() {
  Widget entry() => const ProviderScope(
        child: MaterialApp(home: SignedOutEntry(signIn: Text('SIGN IN'))),
      );

  testWidgets('first launch: the introduction, then sign-in; remembered', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(entry());
    await tester.pumpAndSettle();

    expect(find.text('Welcome to NeoConference'), findsOneWidget);
    expect(find.text('SIGN IN'), findsNothing);

    // Through every page to the last.
    for (var i = 1; i < introPages.length; i++) {
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
    }
    expect(find.text('Invite in a tap'), findsOneWidget);
    await tester.tap(find.text('Get started'));
    await tester.pumpAndSettle();

    expect(find.text('SIGN IN'), findsOneWidget);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool(IntroController.storageKey), isTrue);
  });

  testWidgets('the translation page says what translation does', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(entry());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Hear every speaker in your language'), findsOneWidget);
    expect(find.textContaining('original voice quietly underneath'), findsOneWidget);
  });

  testWidgets('Skip goes straight to sign-in', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(entry());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Skip'));
    await tester.pumpAndSettle();
    expect(find.text('SIGN IN'), findsOneWidget);
  });

  testWidgets('seen before: straight to sign-in', (tester) async {
    SharedPreferences.setMockInitialValues({IntroController.storageKey: true});
    await tester.pumpWidget(entry());
    await tester.pumpAndSettle();
    expect(find.text('SIGN IN'), findsOneWidget);
    expect(find.text('Welcome to NeoConference'), findsNothing);
  });
}

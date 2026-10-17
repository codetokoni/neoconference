import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/core/app_update.dart';

// "Update available": when the LoveWorld AppStore has a newer NeoConference,
// Home says so once per run, as a pop-up, and Update opens the store through
// neoconference.app/download (so the download is counted on the store).
void main() {
  late List<String> opened;
  setUp(() {
    opened = [];
    resetAppUpdatePrompt();
    launchAppUpdate = (url) async => opened.add(url);
  });

  Widget home(AppUpdate? update) => ProviderScope(
        overrides: [appUpdateProvider.overrideWith((ref) async => update)],
        child: const MaterialApp(home: Scaffold(body: AppUpdateCard())),
      );

  const newer = AppUpdate(current: '1.2.5', latest: '1.2.6', storeUrl: kAppUpdateUrl);

  testWidgets('a newer version: the pop-up says so, and Update opens the store link', (tester) async {
    await tester.pumpWidget(home(newer));
    await tester.pumpAndSettle();
    expect(find.text('Update available'), findsWidgets); // pop-up and card
    expect(find.textContaining('NeoConference 1.2.6 is ready (you have 1.2.5)'), findsOneWidget);
    expect(find.textContaining('sign in with KingsChat'), findsOneWidget);

    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.widgetWithText(FilledButton, 'Update')));
    await tester.pumpAndSettle();
    expect(opened, ['https://www.neoconference.app/download']);
    expect(find.byType(AlertDialog), findsNothing);
  });

  testWidgets('Later closes it, and it does not come back in the same run', (tester) async {
    await tester.pumpWidget(home(newer));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Later'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);

    // Home drawn again (back from a meeting): the card stays, no second pop-up.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(home(newer));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('Update available'), findsOneWidget); // the card
    expect(opened, isEmpty);
  });

  testWidgets('up to date: nothing at all', (tester) async {
    await tester.pumpWidget(home(null));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('Update available'), findsNothing);
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/core/app_update.dart';

// When the LoveWorld AppStore has a newer NeoLinguaMeet, the app says so as
// a pop-up over whatever screen is open, the sign-in screen included, and
// Update opens the store through /download (so the download is counted).
//
// - "Update available": Later puts it off; it is said again only when the
//   app comes back after being away for half an hour or more.
// - Each return to the app asks the site again.
// - Below the site's minimum: "Update required", no Later, no way to close.
void main() {
  late List<String> opened;
  late DateTime now;
  late AppUpdate? answer;
  late int asked;

  setUp(() {
    opened = [];
    now = DateTime(2026, 11, 6, 9);
    appUpdateClock = () => now;
    launchAppUpdate = (url) async => opened.add(url);
    answer = null;
    asked = 0;
  });

  Widget app(Widget screen) => ProviderScope(
        overrides: [
          appUpdateProvider.overrideWith((ref) async {
            asked++;
            return answer;
          }),
        ],
        child: MaterialApp(home: AppUpdateGate(child: Scaffold(body: screen))),
      );

  final newer = AppUpdate(current: '1.2.9', latest: '1.2.10', storeUrl: kAppUpdateUrl);
  final tooOld = AppUpdate(current: '1.2.6', latest: '1.2.10', storeUrl: kAppUpdateUrl, required: true);

  /// The app goes to the background for [away], then comes back.
  Future<void> leaveAndReturn(WidgetTester tester, Duration away) async {
    for (final s in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
      tester.binding.handleAppLifecycleStateChanged(s);
    }
    now = now.add(away);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
  }

  Finder dialogButton(String label) =>
      find.descendant(of: find.byType(AlertDialog), matching: find.widgetWithText(FilledButton, label));

  testWidgets('on the sign-in screen too: says a newer version is ready, and Update opens the store', (tester) async {
    answer = newer;
    await tester.pumpWidget(app(const Text('SIGN IN')));
    await tester.pumpAndSettle();
    expect(find.text('Update available'), findsOneWidget);
    expect(find.textContaining('NeoLinguaMeet 1.2.10 is ready (you have 1.2.9)'), findsOneWidget);
    expect(find.textContaining('sign in with KingsChat'), findsOneWidget);

    await tester.tap(dialogButton('Update'));
    await tester.pumpAndSettle();
    expect(opened, ['https://www.neoconference.app/download']);
    expect(find.byType(AlertDialog), findsNothing);
  });

  testWidgets('Later: not again on a quick return, again after half an hour away; every return asks the site', (tester) async {
    answer = newer;
    await tester.pumpWidget(app(const Text('HOME')));
    await tester.pumpAndSettle();
    expect(asked, 1);
    await tester.tap(find.text('Later'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);

    await leaveAndReturn(tester, const Duration(minutes: 5)); // a look at WhatsApp
    expect(asked, 2, reason: 'asked again on return');
    expect(find.byType(AlertDialog), findsNothing);

    await leaveAndReturn(tester, const Duration(minutes: 40));
    expect(asked, 3);
    expect(find.text('Update available'), findsOneWidget);
    expect(opened, isEmpty);
  });

  testWidgets('a release out while the app sat in the background is said on return', (tester) async {
    await tester.pumpWidget(app(const Text('HOME')));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);

    answer = newer; // 1.2.10 published meanwhile
    await leaveAndReturn(tester, const Duration(hours: 3));
    expect(find.text('Update available'), findsOneWidget);
  });

  testWidgets('below the minimum: "Update required", no Later, and back or a tap outside does not close it', (tester) async {
    answer = tooOld;
    await tester.pumpWidget(app(const Text('SIGN IN')));
    await tester.pumpAndSettle();
    expect(find.text('Update required'), findsOneWidget);
    expect(find.textContaining('(1.2.6) can no longer join meetings'), findsOneWidget);
    expect(find.text('Later'), findsNothing);

    await tester.tapAt(const Offset(5, 5)); // outside the dialog
    await tester.pumpAndSettle();
    expect(find.text('Update required'), findsOneWidget);
    final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
    await nav.maybePop(); // the back button
    await tester.pumpAndSettle();
    expect(find.text('Update required'), findsOneWidget);

    // Update opens the store and the pop-up waits behind it.
    await tester.tap(dialogButton('Update'));
    await tester.pumpAndSettle();
    expect(opened, ['https://www.neoconference.app/download']);
    expect(find.text('Update required'), findsOneWidget);

    // Back from the store without updating, even quickly: still required, said once.
    await leaveAndReturn(tester, const Duration(minutes: 2));
    expect(find.text('Update required'), findsOneWidget);
  });

  testWidgets('the minimum lowered while it shows (APP_MIN_VERSION): the required pop-up goes away', (tester) async {
    answer = tooOld;
    await tester.pumpWidget(app(const Text('HOME')));
    await tester.pumpAndSettle();
    expect(find.text('Update required'), findsOneWidget);

    answer = null;
    await leaveAndReturn(tester, const Duration(minutes: 1));
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('HOME'), findsOneWidget);
  });

  testWidgets('up to date: nothing at all', (tester) async {
    await tester.pumpWidget(app(const Text('HOME')));
    await tester.pumpAndSettle();
    await leaveAndReturn(tester, const Duration(hours: 2));
    expect(find.byType(AlertDialog), findsNothing);
  });

  testWidgets('Home keeps its "Update available" card, without a second pop-up of its own', (tester) async {
    answer = newer;
    await tester.pumpWidget(app(const AppUpdateCard()));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget); // the gate's
    await tester.tap(find.text('Later'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('Update available'), findsOneWidget); // the card
    await tester.tap(find.widgetWithText(FilledButton, 'Update'));
    expect(opened, ['https://www.neoconference.app/download']);
  });
}

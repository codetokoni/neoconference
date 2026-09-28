import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/core/load_error.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/screens/schedule_screen.dart';

/// Found on the test emulator with its DNS down: scheduling failed and the
/// screen printed the raw ClientException — Clerk's token URL, session ID
/// and all. Every screen that printed '$e' now says it in words.
void main() {
  // What the token fetch threw, verbatim in shape.
  final dnsFailure = http.ClientException(
    "SocketException: Failed host lookup: 'clerk.neoconference.app'",
    Uri.parse('https://clerk.neoconference.app/v1/client/sessions/sess_3JriLNMWLSp0/tokens'),
  );

  test('a network failure is words, with no session ID', () {
    final said = describeActionError(dnsFailure);
    expect(said, "Couldn't reach NeoConference. Check your connection and try again.");
    expect(said, isNot(contains('sess_')));
  });

  test('a server refusal keeps its words; anything else keeps its own', () {
    expect(describeActionError(const ApiException(status: 403, message: 'Room is locked')), 'Room is locked');
    expect(describeActionError(StateError('camera busy')), contains('camera busy'));
  });

  testWidgets('Schedule says the connection failed, not the exception', (tester) async {
    tester.view.physicalSize = const Size(800, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(ProviderScope(
      overrides: [
        // The session token is fetched first, and that is what failed.
        apiProvider.overrideWithValue(ApiClient(token: () async => throw dnsFailure)),
      ],
      child: const MaterialApp(home: ScheduleScreen()),
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'Manage test');
    await tester.tap(find.text('Schedule meeting'));
    await tester.pumpAndSettle();

    expect(find.textContaining("Couldn't reach NeoConference"), findsOneWidget);
    expect(find.textContaining('sess_'), findsNothing);
    expect(find.textContaining('ClientException'), findsNothing);
  });
}

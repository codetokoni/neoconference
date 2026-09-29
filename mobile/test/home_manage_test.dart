import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/manage/manage_screen.dart';
import 'package:neoconference/src/meetings/meeting_board.dart';
import 'package:neoconference/src/screens/home_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Found on the emulator: a meeting just scheduled shows as "Next up", and
/// that card had no Manage button — only the smaller rows below it did. So
/// the meeting most likely to need a new time or a host could not be
/// managed from the phone at all.
void main() {
  // The real clock: the board decides what is upcoming by DateTime.now(),
  // so a fixed date here made the meeting "past" a day later and the test
  // failed on the calendar, not the code.
  final now = DateTime.now();

  testWidgets('the Next up card opens its meeting\'s Manage page', (tester) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(ProviderScope(
      overrides: [
        ...realMeetingBoardOverrides(),
        nowProvider.overrideWithValue(now),
        sessionIdProvider.overrideWithValue('sess_1'),
        apiProvider.overrideWithValue(ApiClient(
          token: () async => 'jwt',
          http_: MockClient((_) async => http.Response('{"error":"not_found"}', 404)),
        )),
        eventsProvider.overrideWith((ref) async => [
              NeoEvent(
                id: 'evt_next',
                slug: 'manage-test-0928',
                name: 'Manage test 0928',
                state: 'scheduled',
                isPermanent: false,
                isLocked: false,
                waitingRoomEnabled: false,
                scheduledAt: now.add(const Duration(hours: 18)),
              ),
            ]),
      ],
      child: const MaterialApp(home: Scaffold(body: HomeScreen())),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Next up'), findsOneWidget);
    // The support chat is on Home, where it is looked for.
    expect(find.widgetWithText(FloatingActionButton, 'Help'), findsOneWidget);
    await tester.tap(find.byTooltip('Manage meeting'));
    await tester.pumpAndSettle();

    final page = tester.widget<ManageMeetingScreen>(find.byType(ManageMeetingScreen));
    expect(page.slug, 'manage-test-0928');
  });
}

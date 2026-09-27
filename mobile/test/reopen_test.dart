import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/meetings/meeting_board.dart';
import 'package:neoconference/src/meetings/meeting_view.dart';
import 'package:neoconference/src/screens/home_screen.dart';
import 'package:neoconference/src/screens/prejoin_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A finished meeting on the home screen.
///
/// Its card did nothing when tapped: ended meetings were not joinable, so
/// the only way back into your own meeting was typing its code into Join —
/// and joining one somebody had ended left it ended, with the owner inside
/// as an attendee. The card now opens pre-join, which offers to reopen it,
/// and hands the launcher what it needs to do that (the event id).
void main() {
  final now = DateTime(2026, 9, 27, 21, 45);

  testWidgets('an ended meeting opens pre-join offering to reopen it', (tester) async {
    SharedPreferences.setMockInitialValues({});
    MeetingView? launched;

    await tester.pumpWidget(ProviderScope(
      overrides: [
        ...realMeetingBoardOverrides(),
        nowProvider.overrideWithValue(now),
        sessionIdProvider.overrideWithValue('sess_1'),
        eventsProvider.overrideWith((ref) async => [
              NeoEvent(
                id: 'evt_testneo',
                slug: 'testneo',
                name: 'Testneo',
                state: 'ended',
                isPermanent: false,
                isLocked: false,
                waitingRoomEnabled: false,
                startedAt: now.subtract(const Duration(days: 3)),
                endedAt: now.subtract(const Duration(hours: 1)),
              ),
            ]),
        meetingLauncherProvider.overrideWithValue(
          (context, meeting, {required micOn, required cameraOn, required instant}) =>
              launched = meeting,
        ),
      ],
      child: const MaterialApp(home: Scaffold(body: HomeScreen())),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Testneo'));
    await tester.pumpAndSettle();

    expect(find.byType(PreJoinScreen), findsOneWidget);
    expect(find.text('Reopen and join'), findsOneWidget);

    await tester.tap(find.text('Reopen and join'));
    await tester.pumpAndSettle();

    expect(launched?.code, 'testneo');
    expect(launched?.isPast, isTrue);
    expect(launched?.eventId, 'evt_testneo');
  });
}

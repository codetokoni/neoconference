import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/meetings/meeting_board.dart';
import 'package:neoconference/src/screens/home_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The home screen on a slow or failing connection.
///
/// On the phone's Wi-Fi the meetings list took 2.5–4.7 s to arrive, with a
/// placeholder the whole time, and a failure replaced the list with an
/// error page. The list from the last successful load is shown instead.
void main() {
  const savedRoom = {
    'id': 'evt_saved',
    'slug': 'victor4christ',
    'name': "victor4christ's room",
    'state': 'idle',
    'isPermanent': true,
  };

  void saveFor(String session) {
    SharedPreferences.setMockInitialValues({
      'neo.events.saved': jsonEncode({
        'session': session,
        'events': [savedRoom],
      }),
    });
  }

  Widget app(Future<List<NeoEvent>> Function() fetch) => ProviderScope(
        overrides: [
          ...realMeetingBoardOverrides(),
          sessionIdProvider.overrideWithValue('sess_1'),
          eventsProvider.overrideWith((ref) => fetch()),
        ],
        child: const MaterialApp(home: HomeScreen()),
      );

  testWidgets('the saved list is shown while the fresh one loads',
      (tester) async {
    saveFor('sess_1');
    final never = Completer<List<NeoEvent>>();
    await tester.pumpWidget(app(() => never.future));
    await tester.pump();
    await tester.pump();

    expect(find.text("victor4christ's room"), findsOneWidget);
  });

  testWidgets('a failed load keeps the saved list, marked, not an error page',
      (tester) async {
    saveFor('sess_1');
    await tester.pumpWidget(
      app(() async => throw const SocketException('Connection reset by peer')),
    );
    await tester.pumpAndSettle();

    expect(find.text("victor4christ's room"), findsOneWidget);
    expect(find.textContaining('Showing your meetings from earlier'),
        findsOneWidget);
    expect(find.text('Could not load your meetings'), findsNothing);
  });

  testWidgets("another session's saved list is never shown", (tester) async {
    saveFor('sess_someone_else');
    final never = Completer<List<NeoEvent>>();
    await tester.pumpWidget(app(() => never.future));
    await tester.pump();
    await tester.pump();

    expect(find.text("victor4christ's room"), findsNothing);
  });

  testWidgets('with nothing saved, a failure is still the error page',
      (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(
      app(() async => throw const SocketException('Failed host lookup')),
    );
    await tester.pumpAndSettle();

    expect(find.text('Could not load your meetings'), findsOneWidget);
  });
}

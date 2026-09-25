import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:neoconference/src/core/load_error.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/meetings/meeting_board.dart';
import 'package:neoconference/src/screens/home_screen.dart';

/// "Try again" after a dropped connection.
///
/// Found on a real phone: one connection reset while fetching a session
/// token, and the dashboard said "Could not load your meetings" forever.
/// Try again re-ran the board, but the board awaits the meetings list, and
/// that still held the first failure — the retried screen named the same
/// socket port as the original, which a new request cannot do.
void main() {
  late int fetches;

  // The error the phone showed, shape for shape.
  final reset = http.ClientException(
    'SocketException: Connection reset by peer (OS Error: Connection reset '
    'by peer, errno = 104), address = clerk.neoconference.app, port = 53114',
    Uri.parse('https://clerk.neoconference.app/v1/client/sessions/'
        'sess_example/tokens'),
  );

  Widget app() => ProviderScope(
        overrides: [
          ...realMeetingBoardOverrides(),
          // The network: down for the first request, back for the next.
          eventsProvider.overrideWith((ref) async {
            fetches++;
            if (fetches == 1) throw reset;
            return [
              NeoEvent.fromJson(const {
                'id': 'evt_1',
                'slug': 'victor4christ',
                'name': "victor4christ's room",
                'state': 'idle',
                'isPermanent': true,
              }),
            ];
          }),
        ],
        child: const MaterialApp(home: HomeScreen()),
      );

  setUp(() => fetches = 0);

  testWidgets('Try again fetches the meetings again, and shows them',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.text('Could not load your meetings'), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(fetches, 2, reason: 'the retry must reach the network');
    expect(find.text('Could not load your meetings'), findsNothing);
    expect(find.text("victor4christ's room"), findsOneWidget);
  });

  testWidgets('the error says what happened, not what the socket said',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    expect(find.textContaining('SocketException'), findsNothing);
    expect(find.textContaining('sess_'), findsNothing);
    expect(
      find.text("Couldn't reach NeoConference. Check your connection and "
          'try again.'),
      findsOneWidget,
    );
  });

  test('a SocketException on its own is recognised as a network failure', () {
    expect(
      describeLoadError(const SocketException('Failed host lookup')),
      "Couldn't reach NeoConference. Check your connection and try again.",
    );
  });
}

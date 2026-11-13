import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/groups/ring_into_section.dart';

/// "Call people in" in the room: ring members of one of your groups into a
/// meeting that is not a group meeting (`POST /api/events/<id>/ring-in`),
/// against a fake of the web's route.
void main() {
  late List<http.Request> sent;

  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  MockClient server({bool open = true, int getStatus = 200}) => MockClient((req) async {
        sent.add(req);
        if (req.url.path != '/api/events/neomeeting/ring-in') return json({'error': 'not_found'}, 404);
        if (req.method == 'GET') {
          if (getStatus != 200) return json({'error': 'forbidden'}, getStatus);
          return json({
            'open': open,
            'groups': [
              {
                'id': 'g1',
                'name': 'neomeeting',
                'members': [
                  {'userId': 'user_a', 'name': 'Ada'},
                  {'userId': 'user_b', 'name': 'Bola'},
                ],
              },
              {
                'id': 'g2',
                'name': 'hsmanagers',
                'members': [
                  {'userId': 'user_h1', 'name': 'Hana'},
                  {'userId': 'user_h2', 'name': 'Ike'},
                  {'userId': 'user_h3', 'name': 'Jo'},
                ],
              },
            ],
          });
        }
        return json({'ok': true, 'rung': ['user_h1', 'user_h2'], 'busy': ['user_h3']});
      });

  Widget app(MockClient http_) => ProviderScope(
        overrides: [
          sessionIdProvider.overrideWithValue('sess_1'),
          apiProvider.overrideWithValue(ApiClient(token: () async => 'jwt', http_: http_)),
        ],
        child: const MaterialApp(home: Scaffold(body: RingIntoSection(slug: 'neomeeting'))),
      );

  setUp(() => sent = []);

  testWidgets('a host picks a group, everyone in it, and calls them into this meeting', (tester) async {
    var told = 0;
    void listener() => told++;
    ringIntoChanged.addListener(listener);
    addTearDown(() => ringIntoChanged.removeListener(listener));

    await tester.pumpWidget(app(server()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Call people in'));
    await tester.pumpAndSettle();

    expect(find.text('Ada'), findsOneWidget, reason: 'the first group is chosen to start with');
    await tester.tap(find.text('neomeeting (2)'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('hsmanagers (3)').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Everyone in hsmanagers'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Call 3'));
    await tester.pumpAndSettle();

    final post = sent.lastWhere((r) => r.method == 'POST');
    expect(jsonDecode(post.body), {
      'groupId': 'g2',
      'userIds': ['user_h1', 'user_h2', 'user_h3'],
    });
    expect(find.text('Ringing 2 people. 1 is in another meeting and got a message instead.'), findsOneWidget);
    expect(told, 1, reason: 'the Calling section is told to look again');
  });

  testWidgets('Call stays off until someone is chosen', (tester) async {
    await tester.pumpWidget(app(server()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Call people in'));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Call')).onPressed, isNull);
    await tester.tap(find.text('Bola'));
    await tester.pump();
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Call 1')).onPressed, isNotNull);
  });

  testWidgets('nothing shows once the meeting is over, or for someone who may not invite', (tester) async {
    await tester.pumpWidget(app(server(open: false)));
    await tester.pumpAndSettle();
    expect(find.text('Call people in'), findsNothing);
    await tester.pumpWidget(app(server(getStatus: 403)));
    await tester.pumpAndSettle();
    expect(find.text('Call people in'), findsNothing);
  });

  test('what a ring-in did, in words', () {
    expect(ringIntoResultText(1, 0), 'Ringing 1 person.');
    expect(ringIntoResultText(0, 2), '2 are in another meeting and got a message instead.');
    expect(ringIntoResultText(0, 0), 'They have already joined or answered.');
  });
}

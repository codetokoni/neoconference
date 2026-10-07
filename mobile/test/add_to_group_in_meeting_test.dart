import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/tokens.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/room/room_controller.dart';
import 'package:neoconference/src/room/room_widgets.dart';

/// "Add people to a group" in any meeting, for its hosts and moderators: the
/// people in the room, or anyone by KingsChat handle or email, into one of
/// their groups or a new one.
class _Room extends RoomController {
  _Room(RoomState initial) : super(api: ApiClient(token: () async => null), slug: 't') {
    state = initial;
  }
}

void main() {
  late List<http.Request> sent;

  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  MockClient server() => MockClient((req) async {
        sent.add(req);
        final path = req.url.path;
        if (path == '/api/groups' && req.method == 'GET') return json({'groups': []});
        if (path == '/api/groups' && req.method == 'POST') {
          return json({'group': {'id': 'g9', 'name': (jsonDecode(req.body) as Map)['name'], 'settings': {}}});
        }
        if (path == '/api/groups/g9/members') {
          return json({
            'added': [],
            'alreadyMembers': [],
            'notFound': [],
            'pending': [
              {'key': 'kc:kc1', 'kind': 'kc', 'value': 'kc1'},
              {'key': 'email:a@b.com', 'kind': 'email', 'value': 'a@b.com'},
            ],
          });
        }
        // Not a group meeting: the calls panel hides itself.
        return json({'error': 'not_found'}, 404);
      });

  setUpAll(() {
    // The LiveKit Room the controller makes lists devices through WebRTC's
    // plugin, which does not exist in tests.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('FlutterWebRTC.Method'),
      (call) async => call.method == 'getSources' ? {'sources': <Object>[]} : null,
    );
  });

  Future<void> open(WidgetTester tester, String role) async {
    sent = [];
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    // Built on the real clock (its LiveKit Room keeps a periodic timer) and
    // kept alive outside the tree (disposing it disconnects a room that never
    // connected).
    late _Room room;
    await tester.runAsync(() async => room = _Room(RoomState(role: role)));
    final container = ProviderContainer(overrides: [
      roomControllerProvider.overrideWith((ref, slug) => room),
      sessionIdProvider.overrideWithValue('sess_1'),
      apiProvider.overrideWithValue(ApiClient(token: () async => 'jwt', http_: server())),
    ]);
    container.listen(roomControllerProvider('t'), (_, _) {});
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        home: Scaffold(
          body: NeoTheme(palette: NeoPalette.dark, child: const ParticipantsSheet(slug: 't', title: 'Bible study')),
        ),
      ),
    ));
    await tester.pumpAndSettle();
  }

  test('the room\'s signed-in people are the candidates, once each, none ticked', () {
    final c = roomCandidates([
      (identity: 'user_ada#1', name: 'Ada'),
      (identity: 'user_ada#2', name: 'Ada'),
      (identity: 'guest-77', name: 'Visitor'),
      (identity: 'user_bo#9', name: ''),
    ]);
    expect([for (final x in c) x.userId], ['user_ada', 'user_bo']);
    expect([for (final x in c) x.name], ['Ada', 'user_bo']);
    expect(c.every((x) => !x.selected && x.attended), isTrue);
  });

  testWidgets('an attendee is not offered it', (tester) async {
    await open(tester, 'attendee');
    expect(find.text('Add people to a group'), findsNothing);
  });

  testWidgets('a moderator makes a new group by KingsChat handle and email; no account means they join on signing up',
      (tester) async {
    await open(tester, 'cohost');
    await tester.tap(find.text('Add people to a group'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A new group'));
    await tester.pump();
    expect(find.widgetWithText(TextField, 'Bible study'), findsOneWidget, reason: 'named after the meeting');
    await tester.enterText(find.widgetWithText(TextField, 'Add by KingsChat handle or email'), '@KC1 a@b.com');
    await tester.pump();
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Create group'));
    await tester.tap(find.widgetWithText(FilledButton, 'Create group'));
    await tester.pumpAndSettle();

    final create = sent.lastWhere((r) => r.method == 'POST' && r.url.path == '/api/groups');
    // Not from the meeting's attendees: that needs host rank on the meeting,
    // and a moderator does this too. Everyone goes through the members route.
    expect(jsonDecode(create.body), {'name': 'Bible study'});
    final add = sent.lastWhere((r) => r.url.path == '/api/groups/g9/members');
    expect(jsonDecode(add.body), {'emails': ['a@b.com'], 'kcHandles': ['kc1'], 'pending': true});
    expect(find.textContaining('2 people without an account yet will join when they sign up'), findsOneWidget);
  });
}

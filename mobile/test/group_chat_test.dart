import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/groups/group_chat_api.dart';
import 'package:neoconference/src/groups/group_chat_tab.dart';
import 'package:neoconference/src/groups/group_join.dart';
import 'package:neoconference/src/groups/group_models.dart';

/// The group chat on the phone against a fake of the web's routes: what
/// is sent is what the web sends, new messages arrive by polling with the
/// version, and only your own messages (or, as a moderator, anyone's) can
/// be deleted.
void main() {
  late List<http.Request> sent;
  late List<Map<String, dynamic>> stored;
  late int ver;

  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  Map<String, dynamic> msg(String id, String userId, String name, String text, {Map<String, dynamic> extra = const {}}) => {
        'id': id,
        'userId': userId,
        'name': name,
        'text': text,
        'ts': DateTime.now().toUtc().subtract(Duration(minutes: 10 - stored.length)).toIso8601String(),
        ...extra,
      };

  MockClient server() => MockClient((req) async {
        sent.add(req);
        final path = req.url.path;
        if (path == '/api/groups/g1/messages' && req.method == 'GET') {
          final since = req.url.queryParameters['sinceVer'];
          if (since == '$ver') return json({'unchanged': true, 'ver': ver});
          return json({
            'ver': ver,
            'messages': stored,
            'hasOlder': false,
            'live': [
              {'slug': 'cell-night', 'title': 'Cell night'},
            ],
          });
        }
        if (path == '/api/groups/g1/messages' && req.method == 'POST') {
          final body = jsonDecode(req.body) as Map;
          final m = msg('new${stored.length}', 'user_me', 'Ada', body['text'] as String);
          stored.add(m);
          ver++;
          return json({'ok': true, 'message': m}, 201);
        }
        if (path == '/api/groups/g1/messages/read') return json({'ok': true});
        if (path.startsWith('/api/groups/g1/messages/')) {
          final id = path.split('/').last;
          final i = stored.indexWhere((m) => m['id'] == id);
          stored[i] = {...stored[i], 'text': 'Message removed', 'deleted': true};
          ver++;
          return json({'ok': true});
        }
        if (path == '/api/groups') return json({'groups': []});
        return json({'error': 'not_found'}, 404);
      });

  GroupDetail detail({String role = 'participant', bool moderate = false}) => GroupDetail.fromJson({
        'group': {'id': 'g1', 'name': 'Cell Leaders', 'settings': {}},
        'members': [
          {'userId': 'user_me', 'role': role, 'name': 'Ada', 'joinedAt': 1},
          {'userId': 'user_k', 'role': 'participant', 'name': 'Kemi', 'joinedAt': 2},
          {'userId': 'user_kb', 'role': 'participant', 'name': 'Kunle', 'joinedAt': 3},
          {'userId': 'user_b', 'role': 'participant', 'name': 'Bola', 'joinedAt': 4},
        ],
        'activity': [],
        'me': {'userId': 'user_me', 'role': role},
        'capabilities': {'role': role, 'manageMembers': moderate},
      });

  setUp(() {
    sent = [];
    stored = [];
    ver = 1;
    stored.addAll([
      msg('m1', 'user_k', 'Kemi', 'Who is leading tonight?'),
      msg('m2', 'user_me', 'Ada', 'I am'),
      msg('s1', '', 'NeoConference', '“Cell night” has started', extra: {
        'userId': null,
        'system': true,
        'link': {'href': '/room/cell-night?event=cell-night&join=1', 'label': 'Join'},
      }),
    ]);
  });

  Widget app(GroupDetail d) => ProviderScope(
        overrides: [
          sessionIdProvider.overrideWithValue('sess_1'),
          apiProvider.overrideWithValue(ApiClient(token: () async => 'jwt', http_: server())),
        ],
        child: MaterialApp(home: Scaffold(body: GroupChatTab(detail: d))),
      );

  void tall(WidgetTester tester) {
    tester.view.physicalSize = const Size(800, 2000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  testWidgets('shows the conversation, the live meeting, and marks it read', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(detail()));
    await tester.pumpAndSettle();

    expect(find.text('Who is leading tonight?'), findsOneWidget);
    expect(find.text('Kemi'), findsOneWidget, reason: 'others are named; you are not');
    expect(find.text('“Cell night” has started'), findsOneWidget);
    expect(find.text('Live now · Cell night'), findsOneWidget);
    expect(find.text('Today'), findsOneWidget);
    expect(sent.where((r) => r.url.path == '/api/groups/g1/messages/read'), hasLength(1));
  });

  testWidgets('sends a reply as the web does, and polls with the version it has', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(detail()));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('Who is leading tonight?'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reply'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Replying to Kemi'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'Me, at 7');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    final post = sent.singleWhere((r) => r.method == 'POST' && r.url.path == '/api/groups/g1/messages');
    expect(jsonDecode(post.body), {'text': 'Me, at 7', 'replyToId': 'm1'});
    expect(find.text('Me, at 7'), findsOneWidget);
    expect(find.textContaining('Replying to'), findsNothing);

    // The next look asks with the version it had and learns the new one;
    // the one after asks with that, and gets "unchanged".
    await tester.pump(GroupChatTab.every);
    await tester.pumpAndSettle();
    await tester.pump(GroupChatTab.every);
    await tester.pumpAndSettle();
    final polls = sent.where((r) => r.method == 'GET' && r.url.path == '/api/groups/g1/messages').toList();
    expect(polls.first.url.queryParameters.containsKey('sinceVer'), isFalse);
    expect(polls.last.url.queryParameters['sinceVer'], '$ver');
    expect(find.text('Me, at 7'), findsOneWidget, reason: 'merged by id, not shown twice');
  });

  testWidgets('typing @ offers members by name and completes the mention', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(detail()));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'Thanks @K');
    await tester.pump();
    expect(find.widgetWithText(ActionChip, 'Kemi'), findsOneWidget);
    expect(find.widgetWithText(ActionChip, 'Kunle'), findsOneWidget);
    expect(find.widgetWithText(ActionChip, 'Bola'), findsNothing);
    expect(find.widgetWithText(ActionChip, 'Ada'), findsNothing, reason: 'not yourself');

    await tester.tap(find.widgetWithText(ActionChip, 'Kunle'));
    await tester.pump();
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, 'Thanks @Kunle ');
  });

  testWidgets('you may delete your own message but not someone else\'s', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(detail()));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('Who is leading tonight?'));
    await tester.pumpAndSettle();
    expect(find.text('Delete'), findsNothing);
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('I am'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Delete'));
    await tester.pumpAndSettle();

    expect(sent.where((r) => r.method == 'DELETE').single.url.path, '/api/groups/g1/messages/m2');
    expect(find.text('Message removed'), findsOneWidget);
  });

  testWidgets('a moderator may delete anyone\'s message', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(detail(role: 'moderator', moderate: true)));
    await tester.pumpAndSettle();
    await tester.longPress(find.text('Who is leading tonight?'));
    await tester.pumpAndSettle();
    expect(find.text('Delete'), findsOneWidget);
  });

  testWidgets('a system line\'s Join goes into that meeting', (tester) async {
    tall(tester);
    final joined = <String>[];
    final original = joinGroupMeeting;
    joinGroupMeeting = (context, {required slug, required title, straightIn = false}) async => joined.add(slug);
    addTearDown(() => joinGroupMeeting = original);

    await tester.pumpWidget(app(detail()));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Join').first);
    await tester.pumpAndSettle();
    expect(joined, ['cell-night']);
  });

  group('mentions', () {
    test('only an "@…" being typed at the end, at most six', () {
      final names = ['Kemi', 'Kunle', 'Bola', 'Kola', 'Kayode', 'Kate', 'Ken', 'Kim'];
      expect(mentionMatches('hi @k', names, (s) => s), ['Kemi', 'Kunle', 'Kola', 'Kayode', 'Kate', 'Ken']);
      expect(mentionMatches('hi @Bo', names, (s) => s), ['Bola']);
      expect(mentionMatches('hi', names, (s) => s), isNull);
      expect(mentionMatches('email@k', names, (s) => s), isNull, reason: 'an address, not a mention');
      expect(completeMention('hi @Ku', 'Kunle'), 'hi @Kunle ');
    });
  });
}

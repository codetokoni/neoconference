import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/groups/group_screen.dart';
import 'package:neoconference/src/groups/groups_screen.dart';
import 'package:neoconference/src/groups/join_group_screen.dart';
import 'package:neoconference/src/meetings/meeting_share.dart';
import 'package:share_plus/share_plus.dart';

/// Groups on the phone, against a fake of the website's routes. What
/// matters is what reaches the server — the same bodies the web sends — and
/// that a control shows only when the server's capabilities allow it.
void main() {
  late List<http.Request> sent;

  /// The signed-in person's role in the fake group.
  late String role;
  late List<Map<String, dynamic>> members;

  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  const cell = {
    'id': 'g1',
    'name': 'Cell Leaders',
    'description': 'Thursday cell',
    'iconUrl': '',
    'creatorId': 'user_me',
    'createdAt': '2026-10-01T10:00:00.000Z',
    'updatedAt': '2026-10-01T10:00:00.000Z',
    'settings': {'retryIntervalMin': 3, 'maxAttempts': 5},
  };

  Map<String, dynamic> capabilities() => switch (role) {
        'owner' => {
            'role': 'owner',
            'manageMembers': true,
            'assignableRoles': ['host', 'moderator', 'participant'],
            'removableRoles': ['host', 'moderator', 'participant'],
            'editSettings': true,
            'deleteGroup': true,
            'transferOwnership': true,
            'leave': false,
          },
        _ => {
            'role': 'participant',
            'manageMembers': false,
            'assignableRoles': [],
            'removableRoles': [],
            'leave': true,
          },
      };

  MockClient server() => MockClient((req) async {
        sent.add(req);
        final path = req.url.path;
        if (path == '/api/groups' && req.method == 'GET') {
          return json({
            'groups': [
              {...cell, 'role': role, 'memberCount': members.length},
            ],
          });
        }
        if (path == '/api/groups' && req.method == 'POST') {
          return json({
            'ok': true,
            'group': {...cell, 'id': 'g2', 'name': (jsonDecode(req.body) as Map)['name']},
          }, 201);
        }
        if (path == '/api/groups/g1' || path == '/api/groups/g2') {
          if (req.method == 'DELETE') {
            final name = (jsonDecode(req.body) as Map)['confirmName'];
            return name == 'Cell Leaders' ? json({'ok': true}) : json({'error': 'confirmation_mismatch'}, 400);
          }
          if (req.method == 'PATCH') return json({'ok': true, 'group': cell});
          return json({
            'group': cell,
            'members': members,
            'activity': [
              {'ts': 1791300000000, 'actorId': 'user_me', 'type': 'created', 'detail': 'Ada created the group'},
            ],
            'me': {'userId': 'user_me', 'role': role},
            'capabilities': capabilities(),
            'nextMeeting': {
              'id': 'evt_1',
              'slug': 'cell-night',
              'title': 'Cell night',
              'start': DateTime.now().toUtc().toIso8601String(),
              'state': 'live',
            },
          });
        }
        if (path == '/api/groups/g1/members') {
          if (req.method == 'POST') {
            return json({
              'ok': true,
              'added': [
                {'userId': 'user_b', 'role': 'participant', 'name': 'Bola', 'email': 'bola@example.com', 'joinedAt': 1, 'addedBy': 'user_me'},
              ],
              'alreadyMembers': [],
              'notFound': ['nobody@example.com'],
            });
          }
          return json({'ok': true});
        }
        if (path == '/api/groups/g1/invite') {
          return json({
            'ok': true,
            'token': 'abcdefghijklmnopqrstuv',
            'url': 'https://www.neoconference.app/groups/join/abcdefghijklmnopqrstuv',
            'expiresAt': '2026-10-09T10:00:00.000Z',
          });
        }
        if (path == '/api/groups/invite/abcdefghijklmnopqrstuv') {
          if (req.method == 'POST') return json({'ok': true, 'groupId': 'g1', 'role': 'participant', 'alreadyMember': false});
          return json({
            'invite': {'expiresAt': '2026-10-09T10:00:00.000Z'},
            'group': {'name': 'Cell Leaders', 'description': 'Thursday cell', 'iconUrl': '', 'memberCount': 2},
            'signedIn': true,
            'alreadyMember': false,
          });
        }
        if (path == '/api/groups/invite/expiredtoken12345') return json({'error': 'invite_expired'}, 410);
        return json({'error': 'not_found'}, 404);
      });

  setUp(() {
    sent = [];
    role = 'owner';
    members = [
      {'userId': 'user_me', 'role': 'owner', 'name': 'Ada', 'email': 'ada@example.com', 'joinedAt': 1, 'addedBy': null},
      {'userId': 'user_k', 'role': 'participant', 'name': 'Kemi', 'email': 'kemi@example.com', 'joinedAt': 2, 'addedBy': 'user_me'},
    ];
  });

  void tall(WidgetTester tester) {
    tester.view.physicalSize = const Size(800, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  Widget app(Widget home) => ProviderScope(
        overrides: [
          sessionIdProvider.overrideWithValue('sess_1'),
          apiProvider.overrideWithValue(ApiClient(token: () async => 'jwt', http_: server())),
        ],
        child: MaterialApp(home: home),
      );

  Future<void> openTab(WidgetTester tester, String label) async {
    await tester.tap(find.widgetWithText(Tab, label));
    await tester.pumpAndSettle();
  }

  testWidgets('the list shows each group with its size and your role', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('Cell Leaders'), findsOneWidget);
    expect(find.text('2 members · Thursday cell'), findsOneWidget);
    expect(find.text('Owner'), findsOneWidget);
  });

  testWidgets('New group sends the name and opens the new group', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('New group'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Name'), 'Choir');
    await tester.tap(find.text('Create'));
    await tester.pumpAndSettle();

    final create = sent.singleWhere((r) => r.method == 'POST' && r.url.path == '/api/groups');
    expect(jsonDecode(create.body), {'name': 'Choir'});
    expect(find.byType(GroupScreen), findsOneWidget);
    expect(sent.any((r) => r.url.path == '/api/groups/g2'), isTrue);
  });

  testWidgets('the group page leads with the live meeting and a Join button', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();

    expect(find.text('Live now'), findsOneWidget);
    expect(find.text('Cell night'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Join'), findsOneWidget);
  });

  testWidgets('adding by email sends the addresses and says who has no account', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();

    await tester.enterText(find.widgetWithText(TextField, 'Email addresses'), 'bola@example.com, nobody@example.com');
    await tester.tap(find.widgetWithText(FilledButton, 'Add'));
    await tester.pumpAndSettle();

    final add = sent.singleWhere((r) => r.method == 'POST' && r.url.path == '/api/groups/g1/members');
    expect(jsonDecode(add.body), {
      'emails': ['bola@example.com', 'nobody@example.com'],
    });
    expect(find.textContaining('Added Bola.'), findsOneWidget);
    expect(find.textContaining('No account for nobody@example.com'), findsOneWidget);
  });

  testWidgets('a member can be made a Moderator or removed, by their user id', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();

    // The owner's own row has no menu; Kemi's does.
    expect(find.byTooltip('Manage Ada'), findsNothing);
    await tester.tap(find.byTooltip('Manage Kemi'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Make Moderator'));
    await tester.pumpAndSettle();

    final patch = sent.singleWhere((r) => r.method == 'PATCH' && r.url.path == '/api/groups/g1/members');
    expect(jsonDecode(patch.body), {'userId': 'user_k', 'role': 'moderator'});

    await tester.tap(find.byTooltip('Manage Kemi'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove from group'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Remove'));
    await tester.pumpAndSettle();

    final remove = sent.singleWhere((r) => r.method == 'DELETE' && r.url.path == '/api/groups/g1/members');
    expect(remove.url.queryParameters, {'userId': 'user_k'});
  });

  testWidgets('the invite link is created on the server and shared', (tester) async {
    tall(tester);
    final shared = <ShareParams>[];
    final original = shareSheet;
    shareSheet = (p) async => shared.add(p);
    addTearDown(() => shareSheet = original);

    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Share invite link'));
    await tester.pumpAndSettle();

    expect(sent.where((r) => r.url.path == '/api/groups/g1/invite'), hasLength(1));
    expect(shared.single.text, contains('https://www.neoconference.app/groups/join/abcdefghijklmnopqrstuv'));
  });

  testWidgets('a Member sees no add, role or settings controls, and can leave', (tester) async {
    tall(tester);
    role = 'participant';
    members[0]['role'] = 'participant';
    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();

    expect(find.text('Add people'), findsNothing);
    expect(find.byTooltip('Manage Kemi'), findsNothing);
    expect(find.widgetWithText(Tab, 'Settings'), findsNothing);

    await tester.tap(find.text('Leave group'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Leave'));
    await tester.pumpAndSettle();

    final leave = sent.singleWhere((r) => r.method == 'DELETE' && r.url.path == '/api/groups/g1/members');
    expect(leave.url.queryParameters, isEmpty);
  });

  testWidgets('settings save the ringing numbers as the web does', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();
    await openTab(tester, 'Settings');

    await tester.tap(find.byTooltip('More').first); // every 4 minutes
    await tester.tap(find.byTooltip('Fewer').last); // at most 4 times
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    final patch = sent.singleWhere((r) => r.method == 'PATCH' && r.url.path == '/api/groups/g1');
    expect(jsonDecode(patch.body), {
      'name': 'Cell Leaders',
      'description': 'Thursday cell',
      'iconUrl': '',
      'settings': {'retryIntervalMin': 4, 'maxAttempts': 4},
    });
  });

  testWidgets('delete stays off until the name is typed, then sends it', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();
    await openTab(tester, 'Settings');

    await tester.tap(find.text('Delete group'));
    await tester.pumpAndSettle();
    final confirm = find.widgetWithText(TextButton, 'Delete');
    expect(tester.widget<TextButton>(confirm).onPressed, isNull);

    await tester.enterText(find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField)), 'Cell Leaders');
    await tester.pump();
    await tester.tap(confirm);
    await tester.pumpAndSettle();

    final del = sent.singleWhere((r) => r.method == 'DELETE' && r.url.path == '/api/groups/g1');
    expect(jsonDecode(del.body), {'confirmName': 'Cell Leaders'});
  });

  group('invite links', () {
    test('only /groups/join/<token> on neoconference.app is an invite', () {
      expect(groupInviteTokenFromLink(Uri.parse('https://www.neoconference.app/groups/join/abcdefghijklmnopqrstuv')),
          'abcdefghijklmnopqrstuv');
      expect(groupInviteTokenFromLink(Uri.parse('https://neoconference.app/groups/join/abcdefghijklmnopqrstuv')),
          'abcdefghijklmnopqrstuv');
      expect(groupInviteTokenFromLink(Uri.parse('https://evil.example/groups/join/abcdefghijklmnopqrstuv')), isNull);
      expect(groupInviteTokenFromLink(Uri.parse('http://www.neoconference.app/groups/join/abcdefghijklmnopqrstuv')), isNull);
      expect(groupInviteTokenFromLink(Uri.parse('https://www.neoconference.app/groups/join')), isNull);
      expect(groupInviteTokenFromLink(Uri.parse('https://www.neoconference.app/e/cell-night')), isNull);
    });

    testWidgets('Join redeems the token and opens the group', (tester) async {
      tall(tester);
      await tester.pumpWidget(app(const JoinGroupScreen(token: 'abcdefghijklmnopqrstuv')));
      await tester.pumpAndSettle();

      expect(find.text('Cell Leaders'), findsOneWidget);
      expect(find.text('2 members'), findsOneWidget);
      await tester.tap(find.text('Join group'));
      await tester.pumpAndSettle();

      expect(sent.where((r) => r.method == 'POST' && r.url.path == '/api/groups/invite/abcdefghijklmnopqrstuv'), hasLength(1));
      expect(find.byType(GroupScreen), findsOneWidget);
    });

    testWidgets('an expired link says so in the web\'s words', (tester) async {
      tall(tester);
      await tester.pumpWidget(app(const JoinGroupScreen(token: 'expiredtoken12345')));
      await tester.pumpAndSettle();

      expect(find.text('This invite link has expired. Ask for a new one.'), findsOneWidget);
    });
  });
}

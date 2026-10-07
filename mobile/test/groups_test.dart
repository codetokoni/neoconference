import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/groups/group_join.dart';
import 'package:neoconference/src/groups/group_meetings_api.dart';
import 'package:neoconference/src/groups/group_screen.dart';
import 'package:neoconference/src/groups/groups_screen.dart';
import 'package:neoconference/src/groups/incoming_call.dart';
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

  /// The live meeting has since ended (as it does when someone leaves it).
  late bool ended;

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
            'schedule': true,
            'start': true,
            'call': true,
            'addParticipants': true,
            'viewReports': true,
            'exportReports': true,
          },
        _ => {
            'role': 'participant',
            'manageMembers': false,
            'assignableRoles': [],
            'removableRoles': [],
            'leave': true,
          },
      };

  Map<String, dynamic> meeting(String id, String title, String state, {String? seriesId, bool past = false}) => {
        'id': id,
        'slug': id.replaceAll('_', '-'),
        'title': title,
        'description': '',
        'state': state,
        'kind': 'scheduled',
        'start': (past
                ? DateTime.now().subtract(const Duration(days: 7))
                : state == 'live'
                    ? DateTime.now()
                    : DateTime.now().add(const Duration(days: 2)))
            .toUtc()
            .toIso8601String(),
        'durationMin': 60,
        'timezone': 'Africa/Lagos',
        'seriesId': ?seriesId,
        'invitedCount': 5,
        if (past) 'attendedCount': 3,
        'hasPassword': true,
        'waitingRoom': true,
        'createdBy': 'user_me',
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
            // As the server: only to those who manage members.
            'pending': role == 'participant'
                ? []
                : [
                    {'key': 'kc:newkc', 'kind': 'kc', 'value': 'newkc', 'addedBy': 'user_me', 'addedAt': 1791300000000},
                    {'key': 'email:late@example.com', 'kind': 'email', 'value': 'late@example.com', 'addedBy': 'user_me', 'addedAt': 1791300000000},
                  ],
            'activity': [
              {'ts': 1791300000000, 'actorId': 'user_me', 'type': 'created', 'detail': 'Ada created the group'},
            ],
            'me': {'userId': 'user_me', 'role': role},
            'capabilities': capabilities(),
            'nextMeeting': ended ? null : {
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
              // As the server: with pending, people with no account wait;
              // without it, they are not found.
              ...((jsonDecode(req.body) as Map)['pending'] == true
                  ? {
                      'notFound': [],
                      'pending': [
                        {'key': 'email:nobody@example.com', 'kind': 'email', 'value': 'nobody@example.com'},
                        {'key': 'kc:newbie', 'kind': 'kc', 'value': 'newbie'},
                      ],
                      'alreadyPending': [],
                    }
                  : {'notFound': ['nobody@example.com']}),
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
        if (path == '/api/groups/g1/meetings' && req.method == 'GET') {
          if (req.url.queryParameters['scope'] == 'past') {
            // Two pages; the first one short (a private call left out).
            return req.url.queryParameters['cursor'] == null
                ? json({
                    'items': [meeting('evt_p1', 'Last week', 'ended', past: true)],
                    'nextCursor': 1790000000000,
                  })
                : json({
                    'items': [meeting('evt_p2', 'Two weeks ago', 'ended', past: true)],
                    'nextCursor': null,
                  });
          }
          return json({
            'items': [
              if (!ended) meeting('evt_live', 'Cell night', 'live'),
              meeting('evt_s', 'Planning', 'scheduled', seriesId: 's-1'),
            ],
            'nextCursor': null,
          });
        }
        if (path == '/api/groups/g1/meetings' && req.method == 'POST') {
          return json({'ok': true, 'slug': 'cell-leaders-meeting', 'eventUrl': '/x', 'roomUrl': '/x', 'events': [], 'notified': {'sent': 1, 'unreachable': 0}}, 201);
        }
        if (path == '/api/groups/g1/calls') {
          return json({'ok': true, 'slug': 'call-abc', 'eventUrl': '/call-abc', 'roomUrl': '/call-abc', 'notified': {'sent': 1, 'unreachable': 0}}, 201);
        }
        if (path == '/api/groups/g1/meetings/evt_s') {
          return json({'ok': true, 'updated': [], 'cancelled': [], 'notified': {'sent': 1, 'unreachable': 0}});
        }
        if (path == '/api/groups/g1/messages') return json({'ver': 1, 'messages': [], 'hasOlder': false, 'live': []});
        if (path == '/api/groups/invite/expiredtoken12345') return json({'error': 'invite_expired'}, 410);
        return json({'error': 'not_found'}, 404);
      });

  setUp(() {
    sent = [];
    role = 'owner';
    ended = false;
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
        child: MaterialApp(home: home, navigatorObservers: [appRouteObserver]),
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

  testWidgets('with full-screen calls switched off, the list asks to allow them until they are', (tester) async {
    tall(tester);
    var allowed = false;
    var opened = 0;
    final can = CallRinger.canFullScreen, open = CallRinger.openFullScreenSettings;
    CallRinger.canFullScreen = () async => allowed;
    CallRinger.openFullScreenSettings = () async {
      opened++;
      return true;
    };
    addTearDown(() {
      CallRinger.canFullScreen = can;
      CallRinger.openFullScreenSettings = open;
    });

    await tester.pumpWidget(app(const GroupsScreen()));
    await tester.pumpAndSettle();
    expect(find.textContaining('show only as a notification'), findsOneWidget);
    expect(find.text('Cell Leaders'), findsOneWidget);

    await tester.tap(find.widgetWithText(TextButton, 'Allow'));
    await tester.pumpAndSettle();
    expect(opened, 1);

    // Back from the phone's settings with it switched on.
    allowed = true;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(find.textContaining('show only as a notification'), findsNothing);
  });

  testWidgets('with full-screen calls allowed, the list says nothing about them', (tester) async {
    tall(tester);
    final can = CallRinger.canFullScreen;
    CallRinger.canFullScreen = () async => true;
    addTearDown(() => CallRinger.canFullScreen = can);

    await tester.pumpWidget(app(const GroupsScreen()));
    await tester.pumpAndSettle();
    expect(find.textContaining('show only as a notification'), findsNothing);
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
    expect(find.text('Cell night'), findsWidgets);
    expect(find.widgetWithText(FilledButton, 'Join'), findsWidgets);
  });

  testWidgets('adding by email or KingsChat handle keeps people with no account waiting to sign up', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();
    await openTab(tester, 'Members');

    await tester.enterText(
        find.widgetWithText(TextField, 'Emails or KingsChat handles'), 'bola@example.com, Nobody@example.com @Newbie');
    await tester.tap(find.widgetWithText(FilledButton, 'Add'));
    await tester.pumpAndSettle();

    final add = sent.singleWhere((r) => r.method == 'POST' && r.url.path == '/api/groups/g1/members');
    expect(jsonDecode(add.body), {
      'emails': ['bola@example.com', 'nobody@example.com'],
      'kcHandles': ['newbie'],
      'pending': true,
    });
    expect(find.textContaining('Added Bola.'), findsOneWidget);
    expect(find.textContaining('nobody@example.com, @newbie will join when they sign up.'), findsOneWidget);
  });

  testWidgets('a member can be made a Moderator or removed, by their user id', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();
    await openTab(tester, 'Members');

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

  testWidgets('people waiting to sign up are listed, and one can be taken back by its key', (tester) async {
    tall(tester);
    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();
    await openTab(tester, 'Members');

    await tester.ensureVisible(find.text('late@example.com'));
    await tester.pumpAndSettle();
    expect(find.text('WAITING TO SIGN UP (2)'), findsOneWidget, reason: 'NeoSection titles are upper case');
    expect(find.text('@newkc'), findsOneWidget);
    expect(find.text('KingsChat handle · pending'), findsOneWidget);
    expect(find.text('Email · pending'), findsOneWidget);

    await tester.tap(find.byTooltip('Remove @newkc'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Remove'));
    await tester.pumpAndSettle();

    final remove = sent.singleWhere((r) => r.method == 'DELETE' && r.url.path == '/api/groups/g1/members');
    expect(remove.url.queryParameters, {'pending': 'kc:newkc'});
    expect(find.text('@newkc was removed.'), findsOneWidget);
  });

  testWidgets('the invite link is created on the server and shared', (tester) async {
    tall(tester);
    final shared = <ShareParams>[];
    final original = shareSheet;
    shareSheet = (p) async => shared.add(p);
    addTearDown(() => shareSheet = original);

    await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
    await tester.pumpAndSettle();
    await openTab(tester, 'Members');
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
    await openTab(tester, 'Members');

    expect(find.text('Add people'), findsNothing);
    expect(find.byTooltip('Manage Kemi'), findsNothing);
    expect(find.widgetWithText(Tab, 'Settings'), findsNothing);
    expect(find.textContaining(RegExp('waiting to sign up', caseSensitive: false)), findsNothing);
    expect(find.text('@newkc'), findsNothing);

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

  group('meetings', () {
    late List<({String slug, bool straightIn})> joined;

    setUp(() {
      joined = [];
      final originalJoin = joinGroupMeeting;
      joinGroupMeeting = (context, {required slug, required title, straightIn = false}) async =>
          joined.add((slug: slug, straightIn: straightIn));
      final originalTz = deviceTimezone;
      deviceTimezone = () async => 'Africa/Lagos';
      addTearDown(() {
        joinGroupMeeting = originalJoin;
        deviceTimezone = originalTz;
      });
    });

    testWidgets('live first with Join, then coming up, then past pages until the end', (tester) async {
      tall(tester);
      await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
      await tester.pumpAndSettle();

      expect(find.text('Planning'), findsOneWidget);
      expect(find.textContaining('5 invited · repeats'), findsOneWidget);
      expect(find.text('Last week'), findsOneWidget);
      expect(find.textContaining('3 / 5 attended'), findsOneWidget);

      await tester.tap(find.text('Load more'));
      await tester.pumpAndSettle();
      expect(find.text('Two weeks ago'), findsOneWidget);
      expect(find.text('Load more'), findsNothing);
      final pages = sent.where((r) => r.url.queryParameters['scope'] == 'past').toList();
      expect(pages.last.url.queryParameters['cursor'], '1790000000000');

      // The live meeting's own Join goes through the pre-join.
      await tester.tap(find.widgetWithText(FilledButton, 'Join').last);
      await tester.pumpAndSettle();
      expect(joined.single, (slug: 'evt-live', straightIn: false));
    });

    testWidgets('coming back from the meeting reloads the page: no longer live, now past', (tester) async {
      tall(tester);
      // Into the meeting, which ends while there, and back.
      joinGroupMeeting = (context, {required slug, required title, straightIn = false}) async {
        await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('In the room'))));
      };
      await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
      await tester.pumpAndSettle();
      expect(find.text('Live now'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Join').last);
      await tester.pumpAndSettle();
      expect(find.text('In the room'), findsOneWidget);
      ended = true;
      final pastLoads = sent.where((r) => r.url.queryParameters['scope'] == 'past').length;
      Navigator.of(tester.element(find.text('In the room'))).pop();
      await tester.pumpAndSettle();

      expect(find.text('Live now'), findsNothing);
      expect(find.text('Cell night'), findsNothing);
      expect(sent.where((r) => r.url.queryParameters['scope'] == 'past').length, pastLoads + 1);
    });

    testWidgets('pulling down on a tab reloads the group', (tester) async {
      tall(tester);
      await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
      await tester.pumpAndSettle();
      ended = true;

      // Far enough to arm the indicator: a quarter of this tall test view.
      await tester.fling(find.text('Start meeting'), const Offset(0, 1200), 1500);
      await tester.pumpAndSettle();

      expect(find.text('Live now'), findsNothing);
      expect(sent.where((r) => r.method == 'GET' && r.url.path == '/api/groups/g1').length, 2);
    });

    testWidgets('Start meeting starts it for the whole group and goes straight in', (tester) async {
      tall(tester);
      await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Start meeting'));
      await tester.pumpAndSettle();

      final post = sent.singleWhere((r) => r.method == 'POST' && r.url.path == '/api/groups/g1/meetings');
      expect(jsonDecode(post.body), {'mode': 'now', 'title': 'Cell Leaders meeting', 'timezone': 'Africa/Lagos'});
      expect(joined.single, (slug: 'cell-leaders-meeting', straightIn: true));
    });

    testWidgets('Call rings the members chosen and goes straight in', (tester) async {
      tall(tester);
      await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Call'));
      await tester.pumpAndSettle();
      // You are not offered to yourself.
      expect(find.widgetWithText(CheckboxListTile, 'Ada'), findsNothing);
      await tester.tap(find.widgetWithText(CheckboxListTile, 'Kemi'));
      await tester.pump();
      await tester.tap(find.text('Call 1'));
      await tester.pumpAndSettle();

      final post = sent.singleWhere((r) => r.url.path == '/api/groups/g1/calls');
      expect(jsonDecode(post.body), {'userIds': ['user_k'], 'timezone': 'Africa/Lagos'});
      expect(joined.single, (slug: 'call-abc', straightIn: true));
    });

    testWidgets('scheduling a weekly series sends the web\'s fields', (tester) async {
      tall(tester);
      await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Schedule'));
      await tester.pumpAndSettle();

      expect(find.text('Times are in Africa/Lagos.'), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextField, 'Title'), 'Prayer');
      await tester.tap(find.text('Weekly'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Schedule'));
      await tester.pumpAndSettle();

      final post = sent.singleWhere((r) => r.method == 'POST' && r.url.path == '/api/groups/g1/meetings');
      final body = jsonDecode(post.body) as Map<String, dynamic>;
      expect(body['mode'], 'scheduled');
      expect(body['title'], 'Prayer');
      expect(body['timezone'], 'Africa/Lagos');
      expect(body['durationMin'], 60);
      expect(body['waitingRoom'], true);
      expect(DateTime.parse(body['scheduledAt'] as String).isAfter(DateTime.now()), isTrue);
      expect((body['scheduledAt'] as String).endsWith('Z'), isTrue);
      final rec = body['recurrence'] as Map<String, dynamic>;
      expect(rec['freq'], 'weekly');
      expect(rec['interval'], 1);
      expect(rec['count'], 4);
      expect((rec['byWeekday'] as List).single, DateTime.parse(body['scheduledAt'] as String).toLocal().weekday % 7);
      expect(body.containsKey('password'), isFalse);
    });

    testWidgets('changing one of a series asks which, and keeps the password when left blank', (tester) async {
      tall(tester);
      await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Change Planning'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Change'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('This and the following ones'));
      await tester.pumpAndSettle();

      expect(find.text('Leave blank to keep the current password.'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Save changes'));
      await tester.pumpAndSettle();

      final patch = sent.singleWhere((r) => r.method == 'PATCH' && r.url.path == '/api/groups/g1/meetings/evt_s');
      final body = jsonDecode(patch.body) as Map<String, dynamic>;
      expect(body['scope'], 'following');
      expect(body['title'], 'Planning');
      expect(body.containsKey('password'), isFalse);
    });

    testWidgets('cancelling just this one of a series says scope=this', (tester) async {
      tall(tester);
      await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Change Planning'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel meeting'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('This meeting'));
      await tester.pumpAndSettle();

      final del = sent.singleWhere((r) => r.method == 'DELETE' && r.url.path == '/api/groups/g1/meetings/evt_s');
      expect(del.url.queryParameters, {'scope': 'this'});
    });

    testWidgets('a Member can join but not start, schedule, call, change or cancel', (tester) async {
      tall(tester);
      role = 'participant';
      await tester.pumpWidget(app(const GroupScreen(groupId: 'g1', title: 'Cell Leaders')));
      await tester.pumpAndSettle();
      // A Member lands in the chat; the meetings are a tab away.
      expect(find.text('Message the group'), findsOneWidget);
      await openTab(tester, 'Meetings');

      expect(find.text('Start meeting'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Schedule'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Call'), findsNothing);
      expect(find.byTooltip('Change Planning'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Join'), findsWidgets);
    });
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

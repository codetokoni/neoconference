import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:neoconference/src/core/api_client.dart';
import 'package:neoconference/src/events/event.dart';
import 'package:neoconference/src/groups/group_calling_panel.dart';
import 'package:neoconference/src/groups/group_join.dart';
import 'package:neoconference/src/groups/incoming_call.dart';
import 'package:neoconference/src/groups/presence_heartbeat.dart';

/// A group meeting calling while the app is open: found in the same list
/// the web's bell reads, rung on screen, and answered or declined with the
/// same calls the web makes.
void main() {
  late List<http.Request> sent;
  late List<Map<String, dynamic>> notifications;
  late List<String> ringer;
  late List<({String slug, bool straightIn})> joined;

  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

  Map<String, dynamic> ring({String id = 'n1', String ringId = 'r1', String slug = 'cell-night', bool read = false, int inSeconds = 40}) => {
        'id': id,
        'ts': DateTime.now().millisecondsSinceEpoch,
        'type': 'ring',
        'title': 'Cell Leaders: Cell night',
        'body': 'Ada is calling',
        'url': '/room/$slug?event=$slug&join=1',
        'read': read,
        'eventSlug': slug,
        'ringId': ringId,
        'expiresAt': DateTime.now().add(Duration(seconds: inSeconds)).millisecondsSinceEpoch,
        'caller': 'Ada',
        'groupName': 'Cell Leaders',
        'meetingTitle': 'Cell night',
      };

  late Map<String, dynamic> calls;
  late bool addedZed;
  late String groupRole;

  MockClient server() => MockClient((req) async {
        sent.add(req);
        final path = req.url.path;
        if (path == '/api/me/notifications') {
          if (req.method == 'PATCH') return json({'ok': true, 'unread': 0});
          return json({'items': notifications, 'unread': notifications.length, 'nextCursor': null});
        }
        if (path == '/api/events/cell-night/call-response') {
          final action = (jsonDecode(req.body) as Map)['action'];
          return json({'ok': true, 'status': action == 'answer' ? 'answered' : 'declined', 'roomUrl': '/room/cell-night?event=cell-night&join=1'});
        }
        if (path == '/api/events/cell-night/calls') return json(calls);
        if (path == '/api/events/cell-night/participants') {
          return json({'eventId': 'e1', 'groupId': 'g1', 'groupName': 'Cell Leaders', 'kind': 'now', 'canAdd': true, 'candidates': []});
        }
        if (path == '/api/events/cell-night/ring') return json({'ok': true, 'rung': ['user_k'], 'busy': []});
        if (path == '/api/groups/g1' && req.method == 'GET') {
          return json({
            'group': {'id': 'g1', 'name': 'Cell Leaders', 'settings': {}},
            'members': [
              {'userId': 'user_me', 'role': 'owner', 'name': 'Ada', 'joinedAt': 1},
              {'userId': 'user_k', 'role': 'participant', 'name': 'Kemi', 'joinedAt': 2},
              if (addedZed) {'userId': 'user_z', 'role': 'participant', 'name': 'Zed', 'joinedAt': 3},
            ],
            'activity': [],
            'me': {'userId': 'user_me', 'role': groupRole},
            'capabilities': {'role': groupRole, 'manageMembers': groupRole != 'participant'},
          });
        }
        if (path == '/api/groups/g1/members' && req.method == 'POST') {
          addedZed = true;
          return json({
            'ok': true,
            'added': [
              {'userId': 'user_z', 'role': 'participant', 'name': 'Zed', 'joinedAt': 3},
            ],
            'alreadyMembers': [],
            'notFound': [],
          });
        }
        if (path == '/api/events/plain-meeting/calls') return json({'error': 'not_found'}, 404);
        if (path == '/api/me/presence') return json({'ok': true});
        return json({'error': 'not_found'}, 404);
      });

  setUp(() {
    sent = [];
    addedZed = false;
    groupRole = 'owner';
    notifications = [];
    ringer = [];
    joined = [];
    calls = {
      'eventId': 'e1',
      'maxAttempts': 5,
      'people': [
        {'userId': 'user_k', 'name': 'Kemi', 'status': 'missed', 'attempts': 2, 'lastAttemptAt': 1},
        {'userId': 'user_b', 'name': 'Bola', 'status': 'joined', 'attempts': 1, 'lastAttemptAt': 1},
      ],
    };
    final start = CallRinger.start, stop = CallRinger.stop, join = joinGroupMeeting;
    CallRinger.start = () async => ringer.add('start');
    CallRinger.stop = () async => ringer.add('stop');
    joinGroupMeeting = (context, {required slug, required title, straightIn = false}) async =>
        joined.add((slug: slug, straightIn: straightIn));
    addTearDown(() {
      CallRinger.start = start;
      CallRinger.stop = stop;
      joinGroupMeeting = join;
      MeetingHeartbeat.instance.current.value = null;
    });
  });

  Widget app(Widget child) => ProviderScope(
        overrides: [
          sessionIdProvider.overrideWithValue('sess_1'),
          apiProvider.overrideWithValue(ApiClient(token: () async => 'jwt', http_: server())),
        ],
        child: MaterialApp(home: child),
      );

  Widget watcher() => app(const IncomingCallWatcher(child: Scaffold(body: Text('Home'))));

  group('IncomingRing.from', () {
    test('only an unread ring that has not expired', () {
      final now = DateTime.now();
      expect(IncomingRing.from(ring(), now)!.meetingTitle, 'Cell night');
      expect(IncomingRing.from(ring(read: true), now), isNull);
      expect(IncomingRing.from(ring(inSeconds: -1), now), isNull);
      expect(IncomingRing.from({...ring(), 'type': 'missed'}, now), isNull);
      expect(IncomingRing.from({...ring()}..remove('ringId'), now), isNull);
    });
  });

  testWidgets('a ring shows the call and rings; Answer tells the server, marks it read and goes straight in', (tester) async {
    notifications = [ring()];
    await tester.pumpWidget(watcher());
    await tester.pumpAndSettle();

    expect(find.text('Cell night'), findsOneWidget);
    expect(find.text('Ada is calling'), findsOneWidget);
    expect(find.text('CELL LEADERS'), findsOneWidget);
    expect(ringer, ['start']);

    await tester.tap(find.text('Answer'));
    await tester.pumpAndSettle();

    final response = sent.singleWhere((r) => r.url.path == '/api/events/cell-night/call-response');
    expect(jsonDecode(response.body), {'action': 'answer', 'ringId': 'r1'});
    final read = sent.singleWhere((r) => r.method == 'PATCH' && r.url.path == '/api/me/notifications');
    expect(jsonDecode(read.body), {
      'ids': ['n1'],
    });
    expect(ringer.last, 'stop');
    expect(joined.single, (slug: 'cell-night', straightIn: true));
    expect(find.text('Home'), findsOneWidget);
  });

  testWidgets('Decline tells the server and the same ring is not shown again', (tester) async {
    notifications = [ring()];
    await tester.pumpWidget(watcher());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Decline'));
    await tester.pumpAndSettle();
    final response = sent.singleWhere((r) => r.url.path == '/api/events/cell-night/call-response');
    expect(jsonDecode(response.body), {'action': 'decline', 'ringId': 'r1'});
    expect(joined, isEmpty);

    // Still in the list (as unread, had the PATCH been lost): not again.
    await tester.pump(IncomingCallWatcher.every);
    await tester.pumpAndSettle();
    expect(find.text('Answer'), findsNothing);
    expect(sent.where((r) => r.method == 'GET' && r.url.path == '/api/me/notifications').length, greaterThan(1));
  });

  testWidgets('a ring that arrives later is found on the next look', (tester) async {
    await tester.pumpWidget(watcher());
    await tester.pumpAndSettle();
    expect(find.text('Answer'), findsNothing);

    notifications = [ring()];
    await tester.pump(IncomingCallWatcher.every);
    await tester.pumpAndSettle();
    expect(find.text('Answer'), findsOneWidget);
  });

  testWidgets('a ring into the meeting this phone is already in is not shown', (tester) async {
    MeetingHeartbeat.instance.current.value = 'cell-night';
    notifications = [ring()];
    await tester.pumpWidget(watcher());
    await tester.pumpAndSettle();
    expect(find.text('Answer'), findsNothing);
    expect(ringer, isEmpty);
  });

  testWidgets('the call goes away by itself when the ring expires, and stops ringing', (tester) async {
    notifications = [ring(inSeconds: 3)];
    await tester.pumpWidget(watcher());
    await tester.pumpAndSettle();
    expect(find.text('Answer'), findsOneWidget);

    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();
    expect(find.text('Answer'), findsNothing);
    expect(ringer.last, 'stop');
    expect(sent.where((r) => r.url.path.endsWith('/call-response')), isEmpty);
  });

  group('calling panel', () {
    testWidgets('shows how each call went and rings again by user id', (tester) async {
      (calls['people'] as List).add(
        {'userId': 'user_me', 'name': 'Ada', 'status': 'not_called', 'attempts': 0, 'lastAttemptAt': 0},
      );
      await tester.pumpWidget(app(const Scaffold(body: GroupCallingSection(slug: 'cell-night', myUserId: 'user_me'))));
      await tester.pumpAndSettle();

      // The host, who started it, is not on their own list.
      expect(find.text('Ada'), findsNothing);

      expect(find.text('Calling · 1 of 2 joined'), findsOneWidget);
      expect(find.text('Missed · rung 2/5'), findsOneWidget);
      expect(find.text('Joined · rung 1/5'), findsOneWidget);
      // Only someone not already in can be rung again.
      expect(find.text('Ring again'), findsOneWidget);

      await tester.tap(find.text('Ring again'));
      await tester.pumpAndSettle();
      final ringAgain = sent.singleWhere((r) => r.url.path == '/api/events/cell-night/ring');
      expect(jsonDecode(ringAgain.body), {
        'userIds': ['user_k'],
      });
      expect(find.text('Ringing Kemi again.'), findsOneWidget);
    });

    testWidgets('someone here on a link, not in the group, can be added to it by their account', (tester) async {
      await tester.pumpWidget(app(const Scaffold(
        body: SingleChildScrollView(
          child: GroupCallingSection(
            slug: 'cell-night',
            myUserId: 'user_me',
            roomPeople: [
              (userId: 'user_k', name: 'Kemi'), // already in the group
              (userId: 'user_z', name: 'Zed'), // came in on a link
              (userId: 'guest-4f2a', name: 'Visitor'), // signed out: no account to add
            ],
          ),
        ),
      )));
      await tester.pumpAndSettle();

      expect(find.text('Here, not in Cell Leaders'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Add to group'), findsOneWidget);
      expect(find.text('Visitor'), findsNothing);

      await tester.tap(find.widgetWithText(TextButton, 'Add to group'));
      await tester.pumpAndSettle();
      final add = sent.singleWhere((r) => r.method == 'POST' && r.url.path == '/api/groups/g1/members');
      expect(jsonDecode(add.body), {
        'userIds': ['user_z'],
      });
      expect(find.text('Zed is now in Cell Leaders.'), findsOneWidget);
      expect(find.text('Here, not in Cell Leaders'), findsNothing, reason: 'Zed is a member now');
    });

    testWidgets('a Member is not offered "Add to group"', (tester) async {
      groupRole = 'participant';
      await tester.pumpWidget(app(const Scaffold(
        body: SingleChildScrollView(
          child: GroupCallingSection(slug: 'cell-night', myUserId: 'user_me', roomPeople: [(userId: 'user_z', name: 'Zed')]),
        ),
      )));
      await tester.pumpAndSettle();
      expect(find.text('Add to group'), findsNothing);
    });

    testWidgets('in a meeting that is not a group\'s it shows nothing and stops asking', (tester) async {
      await tester.pumpWidget(app(const Scaffold(body: GroupCallingSection(slug: 'plain-meeting'))));
      await tester.pumpAndSettle();
      expect(find.textContaining('Calling'), findsNothing);

      await tester.pump(GroupCallingSection.every * 2);
      expect(sent.where((r) => r.url.path == '/api/events/plain-meeting/calls'), hasLength(1));
    });
  });

  group('pushes and notification taps', () {
    late List<bool> overLock;
    late List<String> shownOver;

    setUp(() {
      overLock = [];
      shownOver = [];
      final lock = CallRinger.overLock;
      CallRinger.overLock = (on) async => overLock.add(on);
      IncomingCalls.instance.onScreenShown = (r) => shownOver.add(r.ringId);
      addTearDown(() {
        CallRinger.overLock = lock;
        IncomingCalls.instance.onScreenShown = null;
        IncomingCallWatcher.openGroup = null;
        IncomingCalls.instance.takePending();
      });
    });

    IncomingRing pushed({String ringId = 'r9'}) =>
        IncomingRing.from({...ring(ringId: ringId), 'expiresAt': '${DateTime.now().add(const Duration(seconds: 40)).millisecondsSinceEpoch}', 'read': 'false'}, DateTime.now())!;

    test('a push\'s values are all strings, and still make a ring', () {
      final r = pushed();
      expect(r.ringId, 'r9');
      expect(r.liveAt(DateTime.now()), isTrue);
      expect(IncomingRing.from({...ring(), 'read': 'true'}, DateTime.now()), isNull);
    });

    test('a notification\'s link names its meeting or its group', () {
      expect(meetingSlugFromPath('/room/abc?event=cell-night&join=1'), 'cell-night');
      expect(meetingSlugFromPath('/room/cell-night'), 'cell-night');
      expect(meetingSlugFromPath('/cell-night'), 'cell-night');
      expect(meetingSlugFromPath('/dashboard/groups/g1?tab=chat'), isNull);
      expect(groupIdFromPath('/dashboard/groups/g1?tab=chat'), 'g1');
      expect(groupIdFromPath('/cell-night'), isNull);
    });

    testWidgets('a ring pushed while open shows the call over the lock screen, then lets go of it', (tester) async {
      await tester.pumpWidget(watcher());
      await tester.pumpAndSettle();
      IncomingCalls.instance.add(RingArrived(pushed()));
      await tester.pumpAndSettle();

      expect(find.text('Answer'), findsOneWidget);
      expect(shownOver, ['r9'], reason: 'its notification is taken down');
      expect(overLock, [true]);

      await tester.tap(find.text('Decline'));
      await tester.pumpAndSettle();
      expect(overLock, [true, false]);
    });

    testWidgets('Answer pressed on the notification goes straight in, without asking again', (tester) async {
      await tester.pumpWidget(watcher());
      await tester.pumpAndSettle();
      IncomingCalls.instance.add(RingArrived(pushed(), answerNow: true));
      await tester.pumpAndSettle();

      expect(find.text('Answer'), findsNothing);
      final response = sent.singleWhere((r) => r.url.path == '/api/events/cell-night/call-response');
      expect(jsonDecode(response.body), {'action': 'answer', 'ringId': 'r9'});
      expect(joined.single, (slug: 'cell-night', straightIn: true));
    });

    testWidgets('a tapped reminder opens its group', (tester) async {
      final opened = <String>[];
      IncomingCallWatcher.openGroup = (_, id) => opened.add(id);
      await tester.pumpWidget(watcher());
      await tester.pumpAndSettle();
      IncomingCalls.instance.add(const NoticeTapped(url: '/cell-night', groupId: 'g1'));
      await tester.pumpAndSettle();
      expect(opened, ['g1']);
      expect(joined, isEmpty);
    });

    testWidgets('a call notification that launched the app is shown once the app is up', (tester) async {
      IncomingCalls.instance.add(RingArrived(pushed(ringId: 'r10')));
      await tester.pumpWidget(watcher());
      await tester.pumpAndSettle();
      expect(find.text('Answer'), findsOneWidget);
    });
  });

  test('the heartbeat says where this phone is, and that it left', () async {
    final api = ApiClient(token: () async => 'jwt', http_: server());
    MeetingHeartbeat.instance.start(api, 'cell-night');
    await Future<void>.delayed(Duration.zero);
    final here = sent.singleWhere((r) => r.method == 'POST' && r.url.path == '/api/me/presence');
    expect(jsonDecode(here.body), {'eventSlug': 'cell-night'});
    expect(MeetingHeartbeat.instance.current.value, 'cell-night');

    // Another meeting's stop leaves this one alone.
    MeetingHeartbeat.instance.stop('other-meeting');
    expect(MeetingHeartbeat.instance.current.value, 'cell-night');

    MeetingHeartbeat.instance.stop('cell-night');
    await Future<void>.delayed(Duration.zero);
    expect(sent.where((r) => r.method == 'DELETE' && r.url.path == '/api/me/presence'), hasLength(1));
    expect(MeetingHeartbeat.instance.current.value, isNull);
  });
}
